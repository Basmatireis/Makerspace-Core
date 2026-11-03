import { useState } from 'react';
import { Button, Link as CarbonLink } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { PageShell } from '../../app/PageShell';
import { MachinePanel } from './components/MachinePanel';
import {
  ConnectorStateTag,
  connectorStateLabel,
  currentStatusText,
  idleText,
  machineRows,
  PageSectionTabs,
  type MachineRow,
} from './components/machineParts';
import { PrintersTab } from './components/PrintersTab';
import { ProcessesTab } from './components/ProcessesTab';
import { JobFormModal } from './dialogs/JobFormModal';
import { MachineSetupWizard } from './dialogs/MachineSetupWizard';
import { integrationLabel } from './processConfig';
import { machineActivityQuery, machinesQuery } from './queries';
import {
  attentionDirectoryColumn,
  DirectoryTable,
  useUrlState,
  type Column,
  type Option,
} from './shared/DirectoryTable';
import { formatQuantity } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { AvailabilityTag, availabilityLabel, currentItemName } from './shared/status';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import { EmptyState } from '../../app/PageState';
import './styles/machines.scss';

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
type TabKey = 'machines' | 'processes' | 'printers';
const tabLabels: Record<TabKey, string> = { machines: 'Machines', processes: 'Processes', printers: 'Printers' };
// Earlier links named the tabs that are now parts of Printers or Processes.
const formerTabs: Record<string, TabKey> = { types: 'processes', notifications: 'printers', catalog: 'printers' };

function ActivityCell({ row }: { row: MachineRow }) {
  if (row.current)
    return (
      <div className="mj-cell-stack">
        <CarbonLink
          as={Link}
          to={
            row.current.kind === 'run'
              ? machineLogbookPaths.run(row.current.id)
              : machineLogbookPaths.job(row.current.id)
          }
        >
          {currentItemName(row.current)}
        </CarbonLink>
        <span className="mj-secondary">{currentStatusText(row.current)}</span>
      </div>
    );
  return <span className="mj-secondary">{idleText(row)}</span>;
}

/** What the machine search matches: name, process and its integration, external ID, availability and connector state. */
const machineSearchText = (row: MachineRow) =>
  [
    row.machine.name,
    row.machine.process.name,
    integrationLabel(row.machine.process.integration),
    row.machine.externalIdentifier,
    availabilityLabel(row.availability),
    row.connectorState === 'none' ? null : connectorStateLabel(row.connector),
    row.connector?.runtimeErrorCode,
    row.machine.attention.map((item) => item.message).join(' '),
  ]
    .filter(Boolean)
    .join(' ');

export function MachinesPage() {
  const can = useCan();
  const canManage = can('machines.manage');
  const navigate = useNavigate();
  const panelFits = useListPanelLayout();
  const [formOpen, setFormOpen] = useState(false);
  const [jobFor, setJobFor] = useState<string | null>(null);
  const url = useUrlState('');
  const [params, setParams] = useSearchParams();
  const tabs: TabKey[] = ['machines', 'processes', 'printers'];
  const requestedParam = params.get('tab') ?? '';
  const requestedTab = (formerTabs[requestedParam] ?? requestedParam) as TabKey;
  const tab: TabKey = tabs.includes(requestedTab) ? requestedTab : 'machines';
  const selectedId = params.get('machine');
  const setParam = (key: string, value: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const selectTab = (id: string) => setParam('tab', id === 'machines' ? null : id);
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

  const allRows = machineRows(machines.data?.items ?? [], activity.data?.items ?? []);
  const statusIds = url.list('status');
  const processIds = url.list('process');
  const collectionIds = url.list('collection');
  const connectorIds = url.list('connector');
  const processes = new Map(allRows.map((row) => [row.machine.process.id, row.machine.process.name]));
  const processOptions: Option[] = [...processes]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  const rows = allRows.filter(
    (row) =>
      (statusIds.length === 0 ? row.availability !== 'retired' : statusIds.includes(row.availability)) &&
      (processIds.length === 0 || processIds.includes(row.machine.process.id)) &&
      (collectionIds.length === 0 ||
        collectionIds.includes(row.machine.automaticCollectionEnabled ? 'automatic' : 'manual')) &&
      (connectorIds.length === 0 || connectorIds.includes(row.connectorState)),
  );
  const selected = selectedId ? allRows.find((row) => row.id === selectedId) : undefined;
  // From 1056 px a row opens the panel next to the table; narrower screens go to the machine page.
  const open = (row: MachineRow) => {
    if (panelFits) setParam('machine', selectedId === row.id ? null : row.id);
    else navigate(machineLogbookPaths.machine(row.id));
  };

  const columns: Column<MachineRow>[] = [
    {
      key: 'availability',
      header: 'Availability',
      className: 'mj-col-center',
      narrow: true,
      sortValue: (row) => availabilityLabel(row.availability),
      render: (row) => <AvailabilityTag availability={row.availability} size="sm" />,
    },
    {
      key: 'machine',
      header: 'Machine',
      className: 'mj-col-wide',
      sortValue: (row) => row.machine.name,
      render: (row) => (
        <div className="mj-cell-stack">
          {panelFits ? (
            <button
              type="button"
              className="mj-name-button"
              aria-expanded={selectedId === row.id}
              data-selected={selectedId === row.id || undefined}
              onClick={() => open(row)}
            >
              {row.machine.name}
            </button>
          ) : (
            <CarbonLink as={Link} to={machineLogbookPaths.machine(row.machine.id)}>
              {row.machine.name}
            </CarbonLink>
          )}
          <span className="mj-secondary">
            {row.machine.process.name}
            {row.machine.automaticCollectionEnabled ? ' · automatic' : ''}
          </span>
          <span className="mj-show-narrow">
            <AvailabilityTag availability={row.availability} size="sm" />
          </span>
        </div>
      ),
    },
    { key: 'activity', header: 'Activity', narrow: true, render: (row) => <ActivityCell row={row} /> },
    {
      key: 'jobs',
      header: 'Jobs',
      className: 'mj-col-num',
      narrow: true,
      firstDirection: 'DESC',
      sortValue: (row) => row.machine.jobCount,
      render: (row) => row.machine.jobCount,
    },
    {
      key: 'failure',
      header: 'Failure rate',
      className: 'mj-col-num',
      narrow: true,
      firstDirection: 'DESC',
      sortValue: (row) => Number(row.machine.failureRate),
      render: (row) => `${formatQuantity(row.machine.failureRate, 1)} %`,
    },
    {
      key: 'connector',
      header: 'Connector',
      className: 'mj-col-num',
      narrow: true,
      render: (row) => <ConnectorStateTag connector={row.connector} />,
    },
    attentionDirectoryColumn((row) => row.machine.attention),
  ];

  const tabsNode = (
    <PageSectionTabs
      label="Machine sections"
      sections={tabs.map((id) => ({ id, label: tabLabels[id] }))}
      selected={tab}
      onChange={selectTab}
    />
  );

  // The Connectors tab moved to Settings, Local services; old links still arrive here.
  if (params.get('tab') === 'connectors') return <Navigate to={machineLogbookPaths.connectors()} replace />;
  return (
    <PageShell
      title="Machines"
      width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Machines' }]}
      tabs={tabsNode}
    >
      {tab === 'machines' && (
        <QueryBoundary query={query} errorMessage="The machines could not be loaded.">
          <ListWithPanel
            className="mj-machines"
            panelLabel="Machine details"
            panel={
              selected ? (
                <MachinePanel
                  key={selected.id}
                  row={selected}
                  onClose={() => setParam('machine', null)}
                  onNewJob={() => setJobFor(selected.id)}
                />
              ) : (
                <div className="mj-panel-placeholder">
                  <EmptyState title="No machine selected" description="Select a machine to see its details here." />
                </div>
              )
            }
          >
            <DirectoryTable<MachineRow>
              id="machines"
              urlPrefix=""
              label="Machines"
              columns={columns}
              rows={rows}
              totalCount={allRows.length}
              searchText={machineSearchText}
              defaultSort={{ key: 'machine', direction: 'ASC' }}
              pageSizes={[25, 50, 100]}
              onRowClick={open}
              filterCategories={[
                {
                  key: 'status',
                  label: 'Availability',
                  options: statusOptions,
                  helperText: 'Retired machines only appear when selected.',
                },
                { key: 'process', label: 'Process', options: processOptions },
                { key: 'collection', label: 'Collection', options: collectionOptions },
                { key: 'connector', label: 'Connector', options: connectorOptions },
              ]}
              toolbarAction={
                canManage ? (
                  <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setFormOpen(true)}>
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
          </ListWithPanel>
        </QueryBoundary>
      )}
      {tab === 'processes' && <ProcessesTab />}
      {tab === 'printers' && <PrintersTab />}
      {canManage && formOpen && <MachineSetupWizard open onClose={() => setFormOpen(false)} />}
      {jobFor && (
        <JobFormModal open onClose={() => setJobFor(null)} mode="create" initialValues={{ machineId: jobFor }} />
      )}
    </PageShell>
  );
}
