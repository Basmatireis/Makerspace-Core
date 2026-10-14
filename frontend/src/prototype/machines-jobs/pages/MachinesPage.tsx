import { useMemo, useState } from 'react';
import {
  Button, DataTable, Link as CarbonLink, MultiSelect, Pagination, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader,
  Tab, TabList, TabPanel, TabPanels, Tabs, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch,
} from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { QueryBoundary } from '../components/QueryBoundary';
import { ConnectorsTab } from '../components/ConnectorsTab';
import { MachineTypesTab } from '../components/MachineTypesTab';
import { MachineSetupWizard } from '../dialogs/MachineSetupWizard';
import { AvailabilityTag, ConnectorIssueTag, formatRelative, machineActivity, type MachineActivity } from '../derived';
import { useNow, useSimulatedQuery, useStore } from '../store';
import type { Job, Machine, MachineType, Print } from '../types';
import '../styles/machines.scss';

type Option = { id: string; label: string };
type SortKey = 'machine' | 'jobs' | 'failure' | 'lastData';
type Row = { machine: Machine; typeName: string; activity: MachineActivity; lastJobAt: string | null; connectorState: 'connected' | 'issue' | 'none' };
type Data = { machines: Machine[]; types: MachineType[]; jobs: Job[]; prints: Print[] };

const emptyData: Data = { machines: [], types: [], jobs: [], prints: [] };
const statusOptions: Option[] = [
  { id: 'available', label: 'Available' }, { id: 'in_use', label: 'In use' }, { id: 'maintenance', label: 'Maintenance' }, { id: 'retired', label: 'Retired' },
];
const collectionOptions: Option[] = [{ id: 'automatic', label: 'Automatic' }, { id: 'manual', label: 'Manual' }];
const connectorOptions: Option[] = [{ id: 'connected', label: 'Connected' }, { id: 'issue', label: 'Issue' }, { id: 'none', label: 'None' }];
const PAGE_SIZES = [10, 25, 50];
type TabKey = 'machines' | 'connectors' | 'types';
const FILTER_KEYS = ['status', 'type', 'collection', 'connector'] as const;
const HEADERS: { key: string; header: string; sort?: SortKey; narrow?: boolean }[] = [
  { key: 'machine', header: 'Machine', sort: 'machine' },
  { key: 'availability', header: 'Availability' },
  { key: 'activity', header: 'Activity', narrow: true },
  { key: 'jobs', header: 'Jobs', sort: 'jobs', narrow: true },
  { key: 'failure', header: 'Failure rate', sort: 'failure', narrow: true },
  { key: 'lastData', header: 'Last data', sort: 'lastData', narrow: true },
];

const listParam = (value: string | null) => (value ?? '').split(',').filter(Boolean);
const selectedOptions = (options: Option[], ids: string[]) => options.filter((option) => ids.includes(option.id));

function ActivityText({ row }: { row: Row }) {
  const { current } = row.activity;
  if (current) return <CarbonLink as={Link} to={current.href}>{current.title}</CarbonLink>;
  if (row.activity.availability === 'maintenance') return <span className="mj-secondary">Marked for maintenance</span>;
  if (row.activity.availability === 'retired') return <span className="mj-secondary">Retired</span>;
  return <span className="mj-secondary">{row.lastJobAt ? `Last job ${formatRelative(row.lastJobAt)}` : 'No jobs yet'}</span>;
}

function AvailabilityTags({ row }: { row: Row }) {
  return <span className="mj-inline"><AvailabilityTag availability={row.activity.availability} size="sm" /><ConnectorIssueTag issue={row.activity.connectorIssue} /></span>;
}

function renderCell(row: Row, key: string) {
  const { machine } = row;
  switch (key) {
    case 'machine':
      return (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={`/machines/${machine.id}`}>{machine.name}</CarbonLink>
          <span className="mj-secondary">{row.typeName}</span>
          <span className="mj-show-narrow"><AvailabilityTags row={row} /></span>
        </div>
      );
    case 'availability': return <AvailabilityTags row={row} />;
    case 'activity': return <ActivityText row={row} />;
    case 'jobs': return machine.jobCount;
    case 'failure': return `${machine.failureRate}%`;
    default: return machine.lastIngestedAt ? formatRelative(machine.lastIngestedAt) : '—';
  }
}

export function MachinesPage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'machine', direction: 'ASC' });
  const [formOpen, setFormOpen] = useState(false);
  const now = useNow();
  const query = useSimulatedQuery<Data>((d) => ({ machines: d.machines, types: d.machineTypes, jobs: d.jobs, prints: d.prints }), emptyData);

  const canManage = store.can('machines.manage');
  const tabs: TabKey[] = store.can('printer_connectors.read') ? ['machines', 'connectors', 'types'] : ['machines', 'types'];
  const requestedTab = params.get('tab') as TabKey | null;
  const tab: TabKey = requestedTab && tabs.includes(requestedTab) ? requestedTab : 'machines';
  const selectTab = (index: number) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (tabs[index] === 'machines' || !tabs[index]) next.delete('tab'); else next.set('tab', tabs[index]);
    return next;
  }, { replace: true });
  const statusIds = listParam(params.get('status'));
  const typeIds = listParam(params.get('type'));
  const collectionIds = listParam(params.get('collection'));
  const connectorIds = listParam(params.get('connector'));
  const search = params.get('q') ?? '';
  const hasActiveFilters = FILTER_KEYS.some((key) => params.get(key));

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in patch)) next.delete('page');
    return next;
  }, { replace: true });
  const updateList = (key: string, items: Option[] | null | undefined) => update({ [key]: (items ?? []).map((item) => item.id).join(',') || null });
  const clearFilters = () => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])));
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((key) => key + 1); };

  const typeOptions: Option[] = query.data.types.map((type) => ({ id: type.id, label: type.name }));
  const allRows = useMemo<Row[]>(() => query.data.machines.map((machine) => {
    const typeName = query.data.types.find((type) => type.id === machine.machineTypeId)?.name ?? 'Unknown type';
    const lastJobAt = query.data.jobs.filter((job) => job.machineId === machine.id).map((job) => job.startsAt).sort().at(-1) ?? null;
    const connectorState: Row['connectorState'] = !machine.connection ? 'none' : ['disconnected', 'degraded'].includes(machine.connection.runtimeState) ? 'issue' : 'connected';
    return { machine, typeName, activity: machineActivity(machine, query.data.prints, query.data.jobs, now), lastJobAt, connectorState };
  }), [query.data, now]);

  const sortValue = (row: Row, key: SortKey): string | number => {
    if (key === 'machine') return row.machine.name;
    if (key === 'jobs') return row.machine.jobCount;
    if (key === 'failure') return row.machine.failureRate;
    return row.machine.lastIngestedAt ?? '';
  };
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const direction = sort.direction === 'ASC' ? 1 : -1;
    return allRows
      .filter((row) => (statusIds.length === 0 ? row.activity.availability !== 'retired' : statusIds.includes(row.activity.availability))
        && (typeIds.length === 0 || typeIds.includes(row.machine.machineTypeId))
        && (collectionIds.length === 0 || collectionIds.includes(row.machine.automaticCollectionEnabled ? 'automatic' : 'manual'))
        && (connectorIds.length === 0 || connectorIds.includes(row.connectorState))
        && (!term || [row.machine.name, row.typeName, row.machine.connection?.serialNumber ?? ''].some((value) => value.toLowerCase().includes(term))))
      .sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        const result = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
        return result * direction;
      });
  }, [allRows, sort, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const rowsById = new Map(allRows.map((row) => [row.machine.id, row]));
  const tableKey = `${page}-${pageSize}-${params.toString()}-${sort.key}-${sort.direction}`;

  const tableRows = pageRows.map((row) => ({
    id: row.machine.id, machine: row.machine.name, availability: row.activity.availability, activity: '', jobs: row.machine.jobCount,
    failure: row.machine.failureRate, lastData: row.machine.lastIngestedAt ?? '',
  }));
  const headers = HEADERS.map(({ key, header }) => ({ key, header }));
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'machine' ? 'ASC' : 'DESC' });

  const emptyState = allRows.length === 0
    ? (
      <EmptyState
        title="No machines yet" description="Add a machine to start logging jobs."
        action={canManage ? <Button kind="tertiary" onClick={() => setFormOpen(true)}>Add machine</Button> : undefined}
      />
    )
    : (
      <EmptyState
        title="No machines found" description="Try different search terms or filters."
        action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>}
      />
    );

  return (
    <PageShell
      title="Machines" description="Machines in the workshop, their availability and recent activity." width="wide"
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Machines' }]}
    >
      <Tabs selectedIndex={tabs.indexOf(tab)} onChange={({ selectedIndex }) => selectTab(selectedIndex)}>
        <TabList aria-label="Machine sections" contained>
          <Tab>Machines</Tab>
          {tabs.includes('connectors') && <Tab>Connectors</Tab>}
          <Tab>Machine types</Tab>
        </TabList>
        <TabPanels>
          <TabPanel><div className="mj-tab-panel">
      <QueryBoundary query={query} errorMessage="The machines could not be loaded.">
        <DataTable key={tableKey} rows={tableRows} headers={headers}>
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container">
              <TableToolbar aria-label="Machines table toolbar">
                <TableToolbarContent>
                  <TableToolbarSearch
                    key={searchKey}
                    id="machines-search"
                    labelText="Search machines"
                    placeholder="Search machines"
                    defaultValue={search}
                    onChange={(_event, value) => update({ q: value ?? '' })}
                    onClear={() => update({ q: null })}
                  />
                  <Button
                    hasIconOnly
                    kind={hasActiveFilters ? 'primary' : 'ghost'}
                    size="md"
                    renderIcon={Filter}
                    iconDescription="Filters"
                    aria-expanded={filtersOpen}
                    aria-controls="machines-filters"
                    onClick={() => setFiltersOpen((open) => !open)}
                  />
                  {canManage && <Button kind="primary" size="lg" onClick={() => setFormOpen(true)}>Add machine</Button>}
                </TableToolbarContent>
              </TableToolbar>
              {filtersOpen && (
                <div id="machines-filters" className="mj-filter-panel" role="region" aria-label="Machines filters">
                  <div className="mj-filter-panel__fields">
                    <MultiSelect id="machines-status-filter" className="mj-filter-panel__field" titleText="Status" label="Active machines" helperText="Retired machines only appear when selected." items={statusOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(statusOptions, statusIds)} onChange={({ selectedItems }) => updateList('status', selectedItems)} />
                    <MultiSelect id="machines-type-filter" className="mj-filter-panel__field" titleText="Type" label="All types" items={typeOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(typeOptions, typeIds)} onChange={({ selectedItems }) => updateList('type', selectedItems)} />
                    <MultiSelect id="machines-collection-filter" className="mj-filter-panel__field" titleText="Collection" label="All collection modes" items={collectionOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(collectionOptions, collectionIds)} onChange={({ selectedItems }) => updateList('collection', selectedItems)} />
                    <MultiSelect id="machines-connector-filter" className="mj-filter-panel__field" titleText="Connector" label="All connector states" items={connectorOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(connectorOptions, connectorIds)} onChange={({ selectedItems }) => updateList('connector', selectedItems)} />
                    <Button kind="ghost" size="md" disabled={!hasActiveFilters} onClick={clearFilters}>Clear filters</Button>
                  </div>
                </div>
              )}
              <Table {...getTableProps()} aria-label="Machines">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => {
                      const meta = HEADERS.find((item) => item.key === header.key);
                      const sortKey = meta?.sort;
                      const className = meta?.narrow ? 'mj-hide-narrow' : undefined;
                      return sortKey ? (
                        <TableHeader
                          key={header.key}
                          className={className}
                          isSortable
                          isSortHeader={sort.key === sortKey}
                          sortDirection={sort.key === sortKey ? sort.direction : 'NONE'}
                          onClick={() => sortBy(sortKey)}
                        >
                          {header.header}
                        </TableHeader>
                      ) : <TableHeader key={header.key} className={className}>{header.header}</TableHeader>;
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((tableRow) => {
                    const row = rowsById.get(tableRow.id);
                    if (!row) return null;
                    const { key, ...rowProps } = getRowProps({ row: tableRow });
                    return (
                      <TableRow key={key} {...rowProps}>
                        {tableRow.cells.map((cell) => (
                          <TableCell key={cell.id} className={HEADERS.find((item) => item.key === cell.info.header)?.narrow ? 'mj-hide-narrow' : undefined}>
                            {renderCell(row, cell.info.header)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {visible.length === 0 && emptyState}
              <Pagination
                page={page}
                pageSize={pageSize}
                pageSizes={PAGE_SIZES}
                totalItems={visible.length}
                onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })}
              />
            </TableContainer>
          )}
        </DataTable>
      </QueryBoundary>
          </div></TabPanel>
          {tabs.includes('connectors') && <TabPanel><ConnectorsTab /></TabPanel>}
          <TabPanel><MachineTypesTab /></TabPanel>
        </TabPanels>
      </Tabs>
      <MachineSetupWizard open={formOpen} onClose={() => setFormOpen(false)} />
    </PageShell>
  );
}
