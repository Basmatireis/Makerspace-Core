import { useMemo, useState } from 'react';
import { Button, ComboBox, Link as CarbonLink, MultiSelect } from '@carbon/react';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listMachineLogbookWorkItems } from '../../api/generated/machine-logbook/machine-logbook';
import type { JobBillingState, ListMachineLogbookWorkItemsParams, ListMachineLogbookWorkItemsSort, WorkItem, WorkItemSource, WorkItemStatus } from '../../api/generated/models';
import { addCalendarDays, zonedDateTimeToISO } from '../../app/dateTime';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { canLookupJobParties } from '../auth/permissions';
import { JobFormModal } from './dialogs/JobFormModal';
import { matchesName } from './dialogs/jobFormHelpers';
import { billingPartySearchQuery, machineLogbookKeys, machinesQuery, materialsQuery, operatorSearchQuery } from './queries';
import { DirectoryTable, selectedOptions, useServerTableState, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { formatDateTime, formatDuration, formatMoney } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { billingStateOptions, jobRowStatusOptions, JobRowStatusTag, workItemName, workItemSecondaryIds } from './shared/status';
import { useCan } from './shared/useCan';
import './styles/jobs.scss';

const sourceOptions: Option[] = [{ id: 'manual', label: 'Manual' }, { id: 'recorded', label: 'Recorded' }];
const FILTER_KEYS = ['status', 'machine', 'source', 'customer', 'operator', 'material', 'billing', 'from', 'to'];
const SORT_KEYS = ['startedAt', 'name', 'machine', 'customer', 'price'];
const statusIds = jobRowStatusOptions.map((option) => option.id as string);
const billingIds = billingStateOptions.map((option) => option.id as string);
const sourceIds = sourceOptions.map((option) => option.id);

/** The generated client repeats the parameter per item (`status=a&status=b`); an empty list sends nothing. */
const nonEmpty = <T extends string>(items: T[]) => (items.length ? items : undefined);

type Person = { id: string; displayName: string };

const columns: Column<WorkItem>[] = [
  {
    key: 'name', header: 'Job', sortValue: () => 0,
    render: (item) => {
      const secondary = workItemSecondaryIds(item);
      const seconds = item.endsAt ? Math.max(0, Math.round((new Date(item.endsAt).getTime() - new Date(item.startedAt).getTime()) / 1000)) : null;
      return (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={item.kind === 'run' ? machineLogbookPaths.run(item.id) : machineLogbookPaths.job(item.id)}>{workItemName(item)}</CarbonLink>
          <span className="mj-secondary">{secondary.length ? secondary.join(' · ') : seconds !== null ? `${formatDuration(seconds)}${item.source === 'manual' ? ' · manual' : ''}` : ''}</span>
          <span className="mj-secondary mj-show-narrow">{item.machineName}</span>
        </div>
      );
    },
  },
  { key: 'machine', header: 'Machine', sortValue: () => 0, narrow: true, render: (item) => item.machineName },
  {
    key: 'customer', header: 'Customer', sortValue: () => 0, narrow: true,
    render: (item) => item.customer || item.operator
      ? <div className="mj-cell-stack"><span>{item.customer?.displayName ?? '—'}</span>{item.operator && <span className="mj-secondary">{item.operator.displayName}</span>}</div>
      : '—',
  },
  { key: 'status', header: 'Status', render: (item) => <JobRowStatusTag status={item.status} size="sm" /> },
  { key: 'startedAt', header: 'Started', sortValue: () => 0, firstDirection: 'DESC', narrow: true, render: (item) => formatDateTime(item.startedAt) },
  { key: 'price', header: 'Price', sortValue: () => 0, firstDirection: 'DESC', render: (item) => formatMoney(item.effectivePrice) },
];

function JobsFilters({ rows }: { rows: WorkItem[] }) {
  const url = useUrlState('');
  const currentUser = useCurrentUser();
  const can = useCan();
  const canLookup = canLookupJobParties(currentUser);
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: can('machines.read') });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: can('inventory.read') });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup, placeholderData: keepPreviousData });

  const statusOptions = jobRowStatusOptions as Option[];
  // Without catalog access the machine filter offers the machines of the rows shown.
  const machineOptions: Option[] = useMemo(() => machines.data
    ? machines.data.items.map((machine) => ({ id: machine.id, label: machine.name }))
    : [...new Map(rows.map((row) => [row.machineId, { id: row.machineId, label: row.machineName }])).values()], [machines.data, rows]);
  const materialOptions: Option[] = useMemo(() => (materials.data?.items ?? []).map((material) => ({ id: material.id, label: material.name })), [materials.data]);
  const people = useMemo<Person[]>(() => {
    const known = new Map<string, Person>();
    for (const row of rows) if (row.customer) known.set(row.customer.id, row.customer);
    for (const party of parties.data?.items ?? []) known.set(party.id, party);
    return [...known.values()];
  }, [rows, parties.data]);
  const operatorList = useMemo<Person[]>(() => {
    const known = new Map<string, Person>();
    for (const row of rows) if (row.operator) known.set(row.operator.personId, { id: row.operator.personId, displayName: row.operator.displayName });
    for (const operator of operators.data?.items ?? []) known.set(operator.personId, { id: operator.personId, displayName: operator.displayName });
    return [...known.values()];
  }, [rows, operators.data]);
  const customerId = url.get('customer');
  const operatorId = url.get('operator');

  return (
    <>
      <MultiSelect id="jobs-status-filter" className="mj-filter-panel__field" titleText="Status" label="All statuses" items={statusOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(statusOptions, url.list('status'))} onChange={({ selectedItems }) => url.setList('status', selectedItems)} />
      <MultiSelect id="jobs-machine-filter" className="mj-filter-panel__field" titleText="Machine" label="All machines" items={machineOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(machineOptions, url.list('machine'))} onChange={({ selectedItems }) => url.setList('machine', selectedItems)} />
      <MultiSelect id="jobs-source-filter" className="mj-filter-panel__field" titleText="Source" label="All sources" items={sourceOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(sourceOptions, url.list('source'))} onChange={({ selectedItems }) => url.setList('source', selectedItems)} />
      {canLookup && (
        <>
          <ComboBox id="jobs-customer-filter" className="mj-filter-panel__field" titleText="Customer" placeholder="Any customer" items={people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={customerId ? people.find((person) => person.id === customerId) ?? { id: customerId, displayName: 'Selected customer' } : null} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => url.set({ customer: selectedItem?.id ?? null })} />
          <ComboBox id="jobs-operator-filter" className="mj-filter-panel__field" titleText="Operator" placeholder="Any operator" items={operatorList} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={operatorId ? operatorList.find((operator) => operator.id === operatorId) ?? { id: operatorId, displayName: 'Selected operator' } : null} onInputChange={setOperatorSearch} onChange={({ selectedItem }) => url.set({ operator: selectedItem?.id ?? null })} />
        </>
      )}
      {can('inventory.read') && (
        <MultiSelect id="jobs-material-filter" className="mj-filter-panel__field" titleText="Material" label="All materials" items={materialOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(materialOptions, url.list('material'))} onChange={({ selectedItems }) => url.setList('material', selectedItems)} />
      )}
      <MultiSelect id="jobs-billing-filter" className="mj-filter-panel__field" titleText="Billing state" label="All billing states" items={billingStateOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(billingStateOptions, url.list('billing'))} onChange={({ selectedItems }) => url.setList('billing', selectedItems)} />
      <div className="mj-filter-panel__field"><DateInput id="jobs-from-filter" labelText="From" value={url.get('from')} onChange={(value) => url.set({ from: value || null })} /></div>
      <div className="mj-filter-panel__field"><DateInput id="jobs-to-filter" labelText="Through" value={url.get('to')} onChange={(value) => url.set({ to: value || null })} /></div>
    </>
  );
}

export function JobsPage() {
  const can = useCan();
  const table = useServerTableState('', { key: 'startedAt', direction: 'DESC' });
  const { url } = table;
  const [jobOpen, setJobOpen] = useState(false);
  const canCreate = can('machine_jobs.create');
  const hasActiveFilters = FILTER_KEYS.some((key) => url.get(key));

  const sortKey = (SORT_KEYS.includes(table.sort.key) ? table.sort.key : 'startedAt') as ListMachineLogbookWorkItemsSort;
  const from = url.get('from');
  const to = url.get('to');
  const params: ListMachineLogbookWorkItemsParams = {
    search: table.search || undefined,
    status: nonEmpty(url.list('status').filter((id) => statusIds.includes(id)) as WorkItemStatus[]),
    machineId: nonEmpty(url.list('machine')),
    source: nonEmpty(url.list('source').filter((id) => sourceIds.includes(id)) as WorkItemSource[]),
    materialId: nonEmpty(url.list('material')),
    billing: nonEmpty(url.list('billing').filter((id) => billingIds.includes(id)) as JobBillingState[]),
    customerId: url.get('customer') || undefined,
    operatorPersonId: url.get('operator') || undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? zonedDateTimeToISO(from, '00:00') : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? zonedDateTimeToISO(addCalendarDays(to, 1), '00:00') : undefined,
    sort: sortKey,
    direction: table.sort.direction === 'ASC' ? 'asc' : 'desc',
    page: table.page,
    pageSize: table.pageSize,
  };
  const query = useQuery(queryOptions({
    queryKey: machineLogbookKeys.workItems(params),
    queryFn: ({ signal }) => listMachineLogbookWorkItems(params, { signal }),
    placeholderData: keepPreviousData,
  }));

  return (
    <PageShell
      title="Jobs" description="Running and finished jobs, and runs reported by machines." width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs' }]}
    >
      <QueryBoundary query={query} errorMessage="Jobs could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server" id="jobs" urlPrefix="" label="Jobs" columns={columns} rows={page.items} total={page.total}
            sort={{ key: sortKey, direction: table.sort.direction }} onSortChange={table.setSort}
            toolbarClassName="mj-jobs-table-toolbar"
            filterFields={<JobsFilters rows={page.items} />}
            hasActiveFilters={hasActiveFilters} onClearFilters={() => url.clear(FILTER_KEYS)}
            toolbarAction={canCreate ? <Button kind="primary" size="lg" onClick={() => setJobOpen(true)}>New job</Button> : undefined}
            empty={{
              title: 'No jobs yet', description: 'Jobs appear here when staff create them or when a machine reports a run.',
              action: canCreate ? <Button kind="tertiary" onClick={() => setJobOpen(true)}>New job</Button> : undefined,
            }}
          />
        )}
      </QueryBoundary>
      {canCreate && <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" />}
    </PageShell>
  );
}
