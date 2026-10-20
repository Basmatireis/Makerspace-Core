import { useMemo, useState } from 'react';
import { Button, ComboBox, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, TableBatchAction } from '@carbon/react';
import { Link as LinkIcon, Merge, Split, TrashCan } from '@carbon/icons-react';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listMachineLogbookWorkItems } from '../../api/generated/machine-logbook/machine-logbook';
import type { JobBillingState, ListMachineLogbookWorkItemsParams, ListMachineLogbookWorkItemsSort, WorkItem, WorkItemSource, WorkItemStatus } from '../../api/generated/models';
import { addCalendarDays, zonedDateTimeToISO } from '../../app/dateTime';
import type { FilterCategory } from '../../app/BatchFilter';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { canLookupJobParties } from '../auth/permissions';
import { AttachRunsModal } from './dialogs/AttachRunsModal';
import { CreateCombinedJobModal, CreateSeparateJobsModal } from './dialogs/BulkJobModals';
import { DeleteRunModal } from './dialogs/DeleteDialogs';
import { DeleteSelectionModal } from './dialogs/DeleteSelectionModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { matchesName } from './dialogs/jobFormHelpers';
import { batchAvailability, canSelectWork, type BatchAction } from './bulkWork';
import { billingPartySearchQuery, machineLogbookKeys, machinesQuery, materialsQuery, operatorSearchQuery } from './queries';
import { DirectoryTable, useServerTableState, type Column, type Option } from './shared/DirectoryTable';
import { formatDateTime, formatDuration, formatMoney } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { billingStateOptions, jobRowStatusOptions, JobRowStatusTag, workItemName, workItemSecondaryIds } from './shared/status';
import { workItemConsumption } from './processConfig';
import { useCan } from './shared/useCan';
import './styles/jobs.scss';

const sourceOptions: Option[] = [{ id: 'manual', label: 'Manual' }, { id: 'recorded', label: 'Recorded' }];
const WORK_REFRESH_MS = 10_000;
const SORT_KEYS = ['startedAt', 'name', 'machine', 'customer', 'price'];
const statusIds = jobRowStatusOptions.map((option) => option.id as string);
const billingIds = billingStateOptions.map((option) => option.id as string);
const sourceIds = sourceOptions.map((option) => option.id);

/** The generated client repeats the parameter per item (`status=a&status=b`); an empty list sends nothing. */
const nonEmpty = <T extends string>(items: T[]) => (items.length ? items : undefined);

type Person = { id: string; displayName: string };
const EMPTY_ITEMS: WorkItem[] = [];

/** Row menu of an unassigned run; jobs are deleted from their own page. */
function UnassignedRunActions({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false);
  if (item.kind !== 'run') return null;
  return (
    <>
      <OverflowMenu aria-label={`Actions for ${item.displayId}`} iconDescription={`Actions for ${item.displayId}`} flipped size="sm">
        <OverflowMenuItem itemText="Delete run" isDelete onClick={() => setOpen(true)} />
      </OverflowMenu>
      <DeleteRunModal open={open} onClose={() => setOpen(false)} runId={item.id} />
    </>
  );
}

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
  { key: 'consumption', header: 'Consumption', narrow: true, render: (item) => workItemConsumption(item.consumption) ?? '—' },
  { key: 'status', header: 'Status', render: (item) => <JobRowStatusTag status={item.status} size="sm" /> },
  { key: 'startedAt', header: 'Started', sortValue: () => 0, firstDirection: 'DESC', narrow: true, render: (item) => formatDateTime(item.startedAt) },
  { key: 'price', header: 'Price', sortValue: () => 0, firstDirection: 'DESC', render: (item) => formatMoney(item.effectivePrice) },
];

const actionsColumn: Column<WorkItem> = { key: 'actions', header: 'Actions', render: (item) => <UnassignedRunActions item={item} /> };

/** Columns of the jobs filter panel. Catalog lookups load once the person may read them; customer and operator are searched on the server. */
function useJobsFilterCategories(rows: WorkItem[]): FilterCategory[] {
  const currentUser = useCurrentUser();
  const can = useCan();
  const canLookup = canLookupJobParties(currentUser);
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: can('machines.read') });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: can('inventory.read') });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup, placeholderData: keepPreviousData });

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

  const categories: FilterCategory[] = [
    { key: 'status', label: 'Status', options: jobRowStatusOptions as Option[] },
    { key: 'machine', label: 'Machine', options: machineOptions },
    { key: 'source', label: 'Source', options: sourceOptions },
  ];
  if (can('inventory.read')) categories.push({ key: 'material', label: 'Material', options: materialOptions });
  categories.push({ key: 'billing', label: 'Billing state', options: billingStateOptions as Option[] });
  if (canLookup) {
    categories.push({
      key: 'people', label: 'People', keys: ['customer', 'operator'],
      render: ({ idPrefix, staged, set }) => {
        const customerId = staged.customer?.[0];
        const operatorId = staged.operator?.[0];
        return (
          <>
            <ComboBox
              autoAlign id={`${idPrefix}-customer`} titleText="Customer" placeholder="Any customer" items={people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName}
              selectedItem={customerId ? people.find((person) => person.id === customerId) ?? { id: customerId, displayName: 'Selected customer' } : null}
              onInputChange={setCustomerSearch} onChange={({ selectedItem }) => set('customer', selectedItem ? [selectedItem.id] : [])}
            />
            <ComboBox
              autoAlign id={`${idPrefix}-operator`} titleText="Operator" placeholder="Any operator" items={operatorList} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName}
              selectedItem={operatorId ? operatorList.find((operator) => operator.id === operatorId) ?? { id: operatorId, displayName: 'Selected operator' } : null}
              onInputChange={setOperatorSearch} onChange={({ selectedItem }) => set('operator', selectedItem ? [selectedItem.id] : [])}
            />
          </>
        );
      },
    });
  }
  categories.push({
    key: 'period', label: 'Started', keys: ['from', 'to'],
    render: ({ idPrefix, staged, set }) => (
      <>
        <DateInput id={`${idPrefix}-from`} labelText="From" value={staged.from?.[0] ?? ''} onChange={(value) => set('from', value ? [value] : [])} />
        <DateInput id={`${idPrefix}-to`} labelText="Through" value={staged.to?.[0] ?? ''} onChange={(value) => set('to', value ? [value] : [])} />
      </>
    ),
  });
  return categories;
}

export function JobsPage() {
  const can = useCan();
  const table = useServerTableState('', { key: 'startedAt', direction: 'DESC' });
  const { url } = table;
  const [jobOpen, setJobOpen] = useState(false);
  const [selection, setSelection] = useState<{ key: string; items: WorkItem[] }>({ key: '', items: EMPTY_ITEMS });
  const [batch, setBatch] = useState<BatchAction | null>(null);
  const canCreate = can('machine_jobs.create');
  const canDelete = can('machine_jobs.delete');
  const selectable = canSelectWork(can);

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
    // Runs reported by connectors appear without a reload.
    refetchInterval: WORK_REFRESH_MS,
  }));
  const filterCategories = useJobsFilterCategories(query.data?.items ?? EMPTY_ITEMS);

  // The selection belongs to one search and filter: changing either starts over, so no action reaches rows that are no longer listed.
  const selectionKey = JSON.stringify({ ...params, sort: undefined, direction: undefined, page: undefined, pageSize: undefined });
  const selected = selection.key === selectionKey ? selection.items : EMPTY_ITEMS;
  const setSelected = (items: WorkItem[]) => setSelection({ key: selectionKey, items });
  // Selected rows keep their place across pages. Rows on the current page are refreshed from the list, so a background refetch
  // does not leave a stale version in the selection.
  const current = new Map((query.data?.items ?? EMPTY_ITEMS).map((item) => [item.id, item]));
  const selectedItems = selected.map((item) => current.get(item.id) ?? item);
  const availability = batchAvailability(selectedItems, can);
  const unavailable = (Object.values(availability)).filter((item) => !item.enabled);
  const selectedRuns = selectedItems.filter((item) => item.kind === 'run');
  const clearSelection = () => setSelected(EMPTY_ITEMS);

  return (
    <PageShell
      title="Jobs" description="Running and finished jobs, and runs reported by machines." width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Jobs' }]}
    >
      {selectable && selectedItems.length > 0 && unavailable.length > 0 && (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Some actions are unavailable for this selection">
          <ul className="mj-skip-list">{unavailable.map((item) => <li key={item.reason}>{item.reason}</li>)}</ul>
        </InlineNotification>
      )}
      <QueryBoundary query={query} errorMessage="Jobs could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server" id="jobs" urlPrefix="" label="Jobs" columns={canDelete ? [...columns, actionsColumn] : columns} rows={page.items} total={page.total}
            sort={{ key: sortKey, direction: table.sort.direction }} onSortChange={table.setSort}
            toolbarClassName="mj-jobs-table-toolbar"
            selection={selectable ? {
              selected: selectedItems, onChange: setSelected, rowLabel: (item) => `Select ${workItemName(item)}`,
              actions: (
                <>
                  <TableBatchAction renderIcon={TrashCan} disabled={!availability.delete.enabled} onClick={() => setBatch('delete')}>Delete</TableBatchAction>
                  <TableBatchAction renderIcon={Split} disabled={!availability.separate.enabled} onClick={() => setBatch('separate')}>Create separate jobs</TableBatchAction>
                  <TableBatchAction renderIcon={Merge} disabled={!availability.combined.enabled} onClick={() => setBatch('combined')}>Create combined job</TableBatchAction>
                  <TableBatchAction renderIcon={LinkIcon} disabled={!availability.attach.enabled} onClick={() => setBatch('attach')}>Attach to job</TableBatchAction>
                </>
              ),
            } : undefined}
            filterCategories={filterCategories}
            toolbarAction={canCreate ? <Button kind="primary" size="lg" onClick={() => setJobOpen(true)}>New job</Button> : undefined}
            empty={{
              title: 'No jobs yet', description: 'Jobs appear here when staff create them or when a machine reports a run.',
              action: canCreate ? <Button kind="tertiary" onClick={() => setJobOpen(true)}>New job</Button> : undefined,
            }}
          />
        )}
      </QueryBoundary>
      {canCreate && <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" />}
      <DeleteSelectionModal open={batch === 'delete'} onClose={() => setBatch(null)} items={selectedItems} onDone={clearSelection} />
      <CreateSeparateJobsModal open={batch === 'separate'} onClose={() => setBatch(null)} runs={selectedRuns} onDone={clearSelection} />
      <CreateCombinedJobModal open={batch === 'combined'} onClose={() => setBatch(null)} runs={selectedRuns} onDone={clearSelection} />
      <AttachRunsModal open={batch === 'attach'} onClose={() => setBatch(null)} runs={selectedRuns} onDone={clearSelection} />
    </PageShell>
  );
}
