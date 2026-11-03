import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  Button,
  DataTable,
  IconButton,
  Link as CarbonLink,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
} from '@carbon/react';
import { Add, Filter } from '@carbon/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type {
  BillingParty,
  JobBillingState,
  ListMachineLogbookWorkItemsParams,
  ListMachineLogbookWorkItemsSort,
  Operator,
  WorkItem,
  WorkItemSource,
} from '../../../api/generated/models';
import { AttentionFlag, attentionColumnClassName } from '../../../app/components/AttentionFlag';
import { FuzzyComboBox, FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { useListPanelLayout } from '../../../app/components/ListWithPanel';
import { formatDate, formatTime } from '../../../app/dateTime';
import { EmptyState } from '../../../app/PageState';
import { useCurrentUser } from '../../auth/auth';
import { canLookupJobParties } from '../../auth/permissions';
import { JobFormModal } from '../dialogs/JobFormModal';
import {
  billingPartySearchQuery,
  machinesQuery,
  operatorSearchQuery,
  processesQuery,
  workItemsQuery,
} from '../queries';
import { useServerTableState } from '../shared/DirectoryTable';
import { machineLogbookPaths } from '../shared/paths';
import { workItemName } from '../shared/status';
import { useCan } from '../shared/useCan';
import {
  billingFilterOptions,
  BillingText,
  jobPhase,
  outcomeFilterOptions,
  sourceFilterOptions,
  spanText,
  statusesFor,
  statusFilterOptions,
} from './jobStatus';
import { UnassignedRunsStrip } from './UnassignedRunsStrip';
import '../styles/jobs.scss';
import './jobs.scss';

/** The item shown in the detail panel next to the table: a job or an unassigned run. */
export type JobsSelection = { kind: 'job' | 'run'; id: string };

export interface JobsTableProps {
  /** Shows the Machine column and the machine and process filters (default). Off on a machine's own page. */
  machineColumn?: boolean;
  /** Lists only the jobs and unassigned runs of this machine; New job starts with it. */
  machineId?: string;
  /** Only items with attention flags (the "Needs attention" section). */
  attention?: boolean;
  /** Prefix of the URL parameters (search, filters, page, sort), so several tables can share a page. */
  urlPrefix?: string;
  /** The selected row, highlighted. */
  selected?: JobsSelection | null;
  /** Row click while the detail panel fits (≥ 1056 px); below that a row click opens the job or run page. */
  onSelect?: (selection: JobsSelection) => void;
}

const SORT_KEYS: Record<string, ListMachineLogbookWorkItemsSort> = {
  job: 'name',
  machine: 'machine',
  recipient: 'customer',
  started: 'startedAt',
};
const PAGE_SIZES = [10, 25, 50];
const WORK_REFRESH_MS = 10_000;
const FILTER_KEYS = ['status', 'outcome', 'machine', 'process', 'source', 'billing', 'customer', 'operator'] as const;

function StartedCell({ item }: { item: WorkItem }) {
  const phase = jobPhase(item.status);
  if (phase === 'planned') return <span className="mj-secondary">Planned</span>;
  return (
    <div className="mj-cell-stack">
      <span>
        {formatDate(item.startedAt)} {formatTime(item.startedAt)}
      </span>
      <span className="mj-secondary">{spanText(item.startedAt, item.endsAt, phase === 'running')}</span>
    </div>
  );
}

/** One combobox per filter category in the row under the toolbar; each choice applies at once. */
function JobsFilterRow({
  prefix,
  value,
  set,
  machineColumn,
}: {
  prefix: string;
  value: (key: string) => string;
  set: (key: string, id: string | null) => void;
  machineColumn: boolean;
}) {
  const can = useCan();
  const currentUser = useCurrentUser();
  const canLookup = canLookupJobParties(currentUser);
  const machines = useQuery({
    ...machinesQuery({ page: 1, pageSize: 100 }),
    enabled: machineColumn && can('machines.read'),
  });
  const processes = useQuery({ ...processesQuery(), enabled: machineColumn && can('machines.read') });
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const parties = useQuery({
    ...billingPartySearchQuery(customerSearch),
    enabled: canLookup,
    placeholderData: keepPreviousData,
  });
  const operators = useQuery({
    ...operatorSearchQuery(operatorSearch),
    enabled: canLookup,
    placeholderData: keepPreviousData,
  });
  const id = (key: string) => `${prefix || 'jobs'}-filter-${key}`;
  const select = (key: string, label: string, options: { id: string; label: string }[], placeholder: string) => (
    <FuzzySelectField
      key={key}
      id={id(key)}
      titleText={label}
      placeholder={placeholder}
      size="md"
      options={options}
      value={value(key) || null}
      onChange={(next) => set(key, next)}
    />
  );
  const customerId = value('customer');
  const operatorId = value('operator');
  const partyItems = parties.data?.items ?? [];
  const operatorItems = operators.data?.items ?? [];
  return (
    <div className="jobs-filters" role="group" aria-label="Filters">
      {select('status', 'Status', statusFilterOptions, 'Any status')}
      {select('outcome', 'Outcome', outcomeFilterOptions, 'Any outcome')}
      {machineColumn &&
        select(
          'machine',
          'Machine',
          (machines.data?.items ?? [])
            .filter((machine) => machine.status !== 'retired')
            .map((machine) => ({ id: machine.id, label: machine.name })),
          'Any machine',
        )}
      {machineColumn &&
        select(
          'process',
          'Process',
          (processes.data?.items ?? [])
            .filter((process) => process.active)
            .map((process) => ({ id: process.id, label: process.name })),
          'Any process',
        )}
      {select('source', 'Runs', sourceFilterOptions, 'Any runs')}
      {select('billing', 'Billing', billingFilterOptions, 'Any billing')}
      {canLookup && (
        <FuzzyComboBox<BillingParty>
          id={id('customer')}
          titleText="Recipient"
          placeholder="Any recipient"
          size="md"
          items={partyItems}
          itemToString={(item) => item?.displayName ?? ''}
          selectedItem={
            customerId
              ? (partyItems.find((party) => party.id === customerId) ?? {
                  kind: 'person',
                  id: customerId,
                  displayName: 'Selected recipient',
                  pricingGroupAssignmentVersion: 0,
                })
              : null
          }
          onInputChange={setCustomerSearch}
          onChange={({ selectedItem }) => set('customer', selectedItem?.id ?? null)}
        />
      )}
      {canLookup && (
        <FuzzyComboBox<Operator>
          id={id('operator')}
          titleText="Operator"
          placeholder="Any operator"
          size="md"
          items={operatorItems}
          itemToString={(item) => item?.displayName ?? ''}
          selectedItem={
            operatorId
              ? (operatorItems.find((item) => item.personId === operatorId) ?? {
                  personId: operatorId,
                  displayName: 'Selected operator',
                })
              : null
          }
          onInputChange={setOperatorSearch}
          onChange={({ selectedItem }) => set('operator', selectedItem?.personId ?? null)}
        />
      )}
    </div>
  );
}

/**
 * The jobs table of the Workshop: the strip of runs reported by machines without a job above a server-paged table
 * of jobs only (machine, job, recipient and operator, start and runtime, billing, attention flag). Search, the filter
 * row, sort and page live in the URL. Reusable on a machine's page with `machineId` and without the machine column.
 */
export function JobsTable({
  machineColumn = true,
  machineId,
  attention,
  urlPrefix = '',
  selected,
  onSelect,
}: JobsTableProps) {
  const can = useCan();
  const navigate = useNavigate();
  const panelFits = useListPanelLayout();
  const table = useServerTableState(urlPrefix, { key: 'started', direction: 'DESC' }, PAGE_SIZES, 25);
  const { url } = table;
  const [filtersOpen, setFiltersOpen] = useState(() => FILTER_KEYS.some((key) => url.get(key)));
  const [jobOpen, setJobOpen] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const searchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);
  const canCreate = can('machine_jobs.create');
  const canDelete = can('machine_jobs.delete');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: can('machines.read') });

  const statuses = statusesFor(url.get('status'), url.get('outcome'));
  const processId = machineColumn ? url.get('process') : '';
  const processMachines = processId
    ? (machines.data?.items ?? []).filter((machine) => machine.process.id === processId).map((machine) => machine.id)
    : null;
  const machineFilter = machineId ?? (machineColumn ? url.get('machine') : '');
  const machineIds = machineFilter
    ? processMachines && !processMachines.includes(machineFilter)
      ? []
      : [machineFilter]
    : processMachines;
  const sortKey = SORT_KEYS[table.sort.key] ?? 'startedAt';
  const params: ListMachineLogbookWorkItemsParams = {
    search: table.search || undefined,
    status: statuses ?? undefined,
    machineId: machineIds ?? undefined,
    source: url.get('source') ? [url.get('source') as WorkItemSource] : undefined,
    billing: url.get('billing') ? [url.get('billing') as JobBillingState] : undefined,
    attention: attention || undefined,
    customerId: url.get('customer') || undefined,
    operatorPersonId: url.get('operator') || undefined,
    sort: sortKey,
    direction: table.sort.direction === 'ASC' ? 'asc' : 'desc',
    page: table.page,
    pageSize: table.pageSize,
  };
  // Filters that exclude each other (planned and successful, a machine outside the process) match nothing.
  const impossible = statuses === null || (machineIds !== null && machineIds.length === 0);
  const query = useQuery({
    ...workItemsQuery(params),
    enabled: !impossible,
    placeholderData: keepPreviousData,
    // Runs reported by connectors appear without a reload.
    refetchInterval: WORK_REFRESH_MS,
  });
  const rows = impossible ? [] : (query.data?.items ?? []);
  const total = impossible ? 0 : (query.data?.total ?? 0);
  const activeFilters = FILTER_KEYS.filter((key) => url.get(key)).length;
  const searching = Boolean(table.search) || activeFilters > 0;

  const open = (selection: JobsSelection) => {
    if (panelFits && onSelect) onSelect(selection);
    else
      navigate(
        selection.kind === 'job' ? machineLogbookPaths.job(selection.id) : machineLogbookPaths.run(selection.id),
      );
  };
  const headers = [
    ...(machineColumn ? [{ key: 'machine', header: 'Machine' }] : []),
    { key: 'job', header: 'Job' },
    { key: 'recipient', header: 'Recipient' },
    { key: 'started', header: 'Started' },
    { key: 'billing', header: 'Billing' },
    { key: 'attention', header: 'Needs attention' },
  ];
  const sortable = new Set(['machine', 'job', 'recipient', 'started']);
  const sortBy = (key: string) =>
    table.setSort(
      table.sort.key === key
        ? { key, direction: table.sort.direction === 'ASC' ? 'DESC' : 'ASC' }
        : { key, direction: key === 'started' ? 'DESC' : 'ASC' },
    );
  const clearFilters = () => {
    url.clear(['q', ...FILTER_KEYS]);
    setSearchKey((value) => value + 1);
  };

  return (
    <div className="jobs-list">
      <UnassignedRunsStrip machineId={machineId} selected={selected} onOpen={open} canDelete={canDelete} />
      <DataTable rows={rows.map((row) => ({ id: row.id }))} headers={headers} size="lg">
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getRowProps }) => (
          <TableContainer className="mj-table-container jobs-table">
            <TableToolbar aria-label="Jobs table toolbar">
              <TableToolbarContent>
                <TableToolbarSearch
                  key={searchKey}
                  id={`${urlPrefix || 'jobs'}-search`}
                  labelText="Search jobs"
                  placeholder="Search jobs"
                  persistent
                  defaultValue={table.search}
                  onChange={(_event, value) => {
                    window.clearTimeout(searchTimer.current);
                    searchTimer.current = window.setTimeout(() => url.set({ q: value || null }), 300);
                  }}
                  onClear={() => {
                    window.clearTimeout(searchTimer.current);
                    url.set({ q: null });
                  }}
                />
                <IconButton
                  kind="ghost"
                  size="lg"
                  label={
                    activeFilters
                      ? `${filtersOpen ? 'Hide' : 'Show'} filters (${activeFilters} active)`
                      : `${filtersOpen ? 'Hide' : 'Show'} filters`
                  }
                  align="bottom"
                  isSelected={filtersOpen || activeFilters > 0}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((value) => !value)}
                >
                  <Filter />
                </IconButton>
                {canCreate && (
                  <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setJobOpen(true)}>
                    New job
                  </Button>
                )}
              </TableToolbarContent>
            </TableToolbar>
            {filtersOpen && (
              <div className="jobs-filters__bar">
                <JobsFilterRow
                  prefix={urlPrefix}
                  machineColumn={machineColumn && !machineId}
                  value={(key) => url.get(key)}
                  set={(key, id) => url.set({ [key]: id })}
                />
                {activeFilters > 0 && (
                  <Button kind="ghost" size="md" onClick={() => url.clear([...FILTER_KEYS])}>
                    Clear all
                  </Button>
                )}
              </div>
            )}
            <Table {...getTableProps()} aria-label="Jobs">
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => {
                    const className =
                      header.key === 'attention'
                        ? attentionColumnClassName
                        : header.key === 'machine' || header.key === 'recipient' || header.key === 'billing'
                          ? 'mj-hide-narrow'
                          : undefined;
                    if (header.key === 'attention')
                      return (
                        <TableHeader key={header.key} className={className}>
                          <span className="cds--visually-hidden">{header.header}</span>
                        </TableHeader>
                      );
                    return sortable.has(header.key) ? (
                      <TableHeader
                        key={header.key}
                        className={className}
                        isSortable
                        isSortHeader={table.sort.key === header.key}
                        sortDirection={table.sort.key === header.key ? table.sort.direction : 'NONE'}
                        onClick={() => sortBy(header.key)}
                      >
                        {header.header}
                      </TableHeader>
                    ) : (
                      <TableHeader key={header.key} className={className}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((tableRow) => {
                  const item = rows.find((row) => row.id === tableRow.id);
                  if (!item) return null;
                  const { key, ...rowProps } = getRowProps({ row: tableRow });
                  const isSelected = selected?.kind === 'job' && selected.id === item.id;
                  return (
                    <TableRow
                      key={key}
                      {...rowProps}
                      isSelected={isSelected}
                      aria-selected={isSelected || undefined}
                      className="mj-row-clickable"
                      onClick={(event: MouseEvent<HTMLElement>) => {
                        if (!(event.target as HTMLElement).closest('a, button, input'))
                          open({ kind: 'job', id: item.id });
                      }}
                    >
                      {machineColumn && <TableCell className="mj-hide-narrow">{item.machineName}</TableCell>}
                      <TableCell>
                        <div className="mj-cell-stack">
                          <CarbonLink as={Link} to={machineLogbookPaths.job(item.id)}>
                            {workItemName(item)}
                          </CarbonLink>
                          <span className="mj-secondary">
                            {item.displayId}
                            {machineColumn && <span className="mj-show-narrow"> · {item.machineName}</span>}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="mj-hide-narrow">
                        <div className="mj-cell-stack">
                          <span>{item.customer?.displayName ?? '—'}</span>
                          {item.operator && <span className="mj-secondary">{item.operator.displayName}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StartedCell item={item} />
                      </TableCell>
                      <TableCell className="mj-hide-narrow">
                        <BillingText status={item.status} billing={item.billing} />
                      </TableCell>
                      <TableCell className={attentionColumnClassName}>
                        <AttentionFlag attention={item.attention} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {query.isError && (
              <EmptyState title="Jobs could not be loaded" description="Reload the page to try again." />
            )}
            {!query.isError &&
              (query.isSuccess || impossible) &&
              total === 0 &&
              (searching ? (
                <EmptyState
                  title="No jobs match"
                  description="Try different search terms or filters."
                  action={
                    <Button kind="tertiary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No jobs yet"
                  description="Jobs appear here when staff create them or claim a run a machine reported."
                  action={
                    canCreate ? (
                      <Button kind="tertiary" onClick={() => setJobOpen(true)}>
                        New job
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            <Pagination
              page={table.page}
              pageSize={table.pageSize}
              pageSizes={PAGE_SIZES}
              totalItems={total}
              onChange={({ page, pageSize }) => url.set({ page: String(page), pageSize: String(pageSize) })}
            />
          </TableContainer>
        )}
      </DataTable>
      {canCreate && (
        <JobFormModal
          open={jobOpen}
          onClose={() => setJobOpen(false)}
          mode="create"
          initialValues={machineId ? { machineId } : undefined}
        />
      )}
    </div>
  );
}
