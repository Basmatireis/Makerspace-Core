import { useState } from 'react';
import { Button, Link as CarbonLink } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type { Machine, MachineAvailability, MachineCurrentItem } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { MachineTypesTab } from './components/MachineTypesTab';
import { MachineSetupWizard } from './dialogs/MachineSetupWizard';
import { machineActivityQuery, machinesQuery } from './queries';
import { DirectoryTable, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { formatQuantity, formatRelative } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { AvailabilityTag, ConnectorIssueTag, connectorIssue, currentItemName } from './shared/status';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/machines.scss';

type Row = {
  id: string;
  machine: Machine;
  availability: MachineAvailability;
  current: MachineCurrentItem | undefined;
  issue: string | null;
  connectorState: 'connected' | 'issue' | 'none';
  lastJobAt: string | null;
};

const statusOptions: Option[] = [
  { id: 'available', label: 'Available' },
  { id: 'in_use', label: 'In use' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'retired', label: 'Retired' },
];
const collectionOptions: Option[] = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'manual', label: 'Manual' },
];
const connectorOptions: Option[] = [
  { id: 'connected', label: 'Connected' },
  { id: 'issue', label: 'Issue' },
  { id: 'none', label: 'None' },
];
type TabKey = 'machines' | 'types';
const tabLabels: Record<TabKey, string> = { machines: 'Machines', types: 'Machine types' };

function ActivityText({ row }: { row: Row }) {
  if (row.current) {
    const href =
      row.current.kind === 'run' ? machineLogbookPaths.run(row.current.id) : machineLogbookPaths.job(row.current.id);
    return (
      <CarbonLink as={Link} to={href}>
        {currentItemName(row.current)}
      </CarbonLink>
    );
  }
  if (row.availability === 'maintenance') return <span className="mj-secondary">Marked for maintenance</span>;
  if (row.availability === 'retired') return <span className="mj-secondary">Retired</span>;
  return (
    <span className="mj-secondary">{row.lastJobAt ? `Last job ${formatRelative(row.lastJobAt)}` : 'No jobs yet'}</span>
  );
}

function AvailabilityTags({ row }: { row: Row }) {
  return (
    <span className="mj-inline">
      <AvailabilityTag availability={row.availability} size="sm" />
      <ConnectorIssueTag issue={row.issue} />
    </span>
  );
}

const columns: Column<Row>[] = [
  {
    key: 'machine',
    header: 'Machine',
    sortValue: (row) => row.machine.name,
    render: (row) => (
      <div className="mj-cell-stack">
        <CarbonLink as={Link} to={machineLogbookPaths.machine(row.machine.id)}>
          {row.machine.name}
        </CarbonLink>
        <span className="mj-secondary">{row.machine.machineType.name}</span>
        <span className="mj-show-narrow">
          <AvailabilityTags row={row} />
        </span>
      </div>
    ),
  },
  { key: 'availability', header: 'Availability', render: (row) => <AvailabilityTags row={row} /> },
  { key: 'activity', header: 'Activity', narrow: true, render: (row) => <ActivityText row={row} /> },
  {
    key: 'jobs',
    header: 'Jobs',
    narrow: true,
    firstDirection: 'DESC',
    sortValue: (row) => row.machine.jobCount,
    render: (row) => row.machine.jobCount,
  },
  {
    key: 'failure',
    header: 'Failure rate',
    narrow: true,
    firstDirection: 'DESC',
    sortValue: (row) => Number(row.machine.failureRate),
    render: (row) => `${formatQuantity(row.machine.failureRate, 1)}%`,
  },
  {
    key: 'lastData',
    header: 'Last data',
    narrow: true,
    firstDirection: 'DESC',
    sortValue: (row) => row.machine.lastIngestedAt ?? '',
    render: (row) => (row.machine.lastIngestedAt ? formatRelative(row.machine.lastIngestedAt) : '—'),
  },
];

export function MachinesPage() {
  const can = useCan();
  const canManage = can('machines.manage');
  const [formOpen, setFormOpen] = useState(false);
  const url = useUrlState('');
  const [params, setParams] = useSearchParams();
  const tabs: TabKey[] = ['machines', 'types'];
  const requestedTab = params.get('tab') as TabKey | null;
  const tab: TabKey = requestedTab && tabs.includes(requestedTab) ? requestedTab : 'machines';
  const selectTab = (id: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id === 'machines') next.delete('tab');
        else next.set('tab', id);
        return next;
      },
      { replace: true },
    );
  const switcher = (
    <SectionSwitcher
      label="Machine sections"
      sections={tabs.map((id) => ({ id, label: tabLabels[id] }))}
      selected={tab}
      onChange={selectTab}
    />
  );
  useNow();
  // A single makerspace has far fewer machines than one page holds, so the table filters, sorts and pages them in the browser.
  const machines = useQuery(machinesQuery({ pageSize: 100 }));
  const activity = useQuery(machineActivityQuery());
  const query = {
    status:
      machines.isError || activity.isError ? 'error' : machines.isPending || activity.isPending ? 'pending' : 'success',
    data: machines.data,
    refetch: () => {
      void activity.refetch();
      return machines.refetch();
    },
  } as const;

  const byMachine = new Map((activity.data?.items ?? []).map((item) => [item.machineId, item]));
  const allRows: Row[] = (machines.data?.items ?? []).map((machine) => {
    const item = byMachine.get(machine.id);
    const availability: MachineAvailability =
      item?.availability ?? (machine.status === 'active' ? 'available' : machine.status);
    const connector = item?.connector;
    const connectorState: Row['connectorState'] = !connector?.runtimeState
      ? 'none'
      : ['disconnected', 'degraded'].includes(connector.runtimeState)
        ? 'issue'
        : 'connected';
    return {
      id: machine.id,
      machine,
      availability,
      current: item?.current,
      connectorState,
      lastJobAt: item?.lastJobStartedAt ?? null,
      issue: availability === 'retired' ? null : connectorIssue(connector ?? undefined),
    };
  });

  const statusIds = url.list('status');
  const typeIds = url.list('type');
  const collectionIds = url.list('collection');
  const connectorIds = url.list('connector');
  const machineTypes = new Map(allRows.map((row) => [row.machine.machineType.id, row.machine.machineType.name]));
  const typeOptions: Option[] = [...machineTypes]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));

  const rows = allRows.filter(
    (row) =>
      (statusIds.length === 0 ? row.availability !== 'retired' : statusIds.includes(row.availability)) &&
      (typeIds.length === 0 || typeIds.includes(row.machine.machineType.id)) &&
      (collectionIds.length === 0 ||
        collectionIds.includes(row.machine.automaticCollectionEnabled ? 'automatic' : 'manual')) &&
      (connectorIds.length === 0 || connectorIds.includes(row.connectorState)),
  );

  // The Connectors tab moved to Settings, Local services; old links still arrive here.
  if (params.get('tab') === 'connectors') return <Navigate to={machineLogbookPaths.connectors()} replace />;
  return (
    <PageShell
      title="Machines"
      description="Machines in the workshop, their availability and recent activity."
      width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Machines' }]}
    >
      {tab === 'machines' && (
        <QueryBoundary query={query} errorMessage="The machines could not be loaded.">
          <DirectoryTable<Row>
            id="machines"
            urlPrefix=""
            label="Machines"
            columns={columns}
            rows={rows}
            totalCount={allRows.length}
            switcher={switcher}
            searchText={(row) =>
              [row.machine.name, row.machine.machineType.name, row.machine.externalIdentifier ?? ''].join(' ')
            }
            defaultSort={{ key: 'machine', direction: 'ASC' }}
            filterCategories={[
              {
                key: 'status',
                label: 'Status',
                options: statusOptions,
                helperText: 'Retired machines only appear when selected.',
              },
              { key: 'type', label: 'Type', options: typeOptions },
              { key: 'collection', label: 'Collection', options: collectionOptions },
              { key: 'connector', label: 'Connector', options: connectorOptions },
            ]}
            toolbarAction={
              canManage ? (
                <Button kind="primary" size="lg" onClick={() => setFormOpen(true)}>
                  Add machine
                </Button>
              ) : undefined
            }
            empty={{
              title: 'No machines yet',
              description: 'Add a machine to start logging jobs.',
              action: canManage ? (
                <Button kind="tertiary" onClick={() => setFormOpen(true)}>
                  Add machine
                </Button>
              ) : undefined,
            }}
          />
        </QueryBoundary>
      )}
      {tab === 'types' && <MachineTypesTab switcher={switcher} />}
      {canManage && formOpen && <MachineSetupWizard open onClose={() => setFormOpen(false)} />}
    </PageShell>
  );
}
