import { useMemo, useState } from 'react';
import {
  Button, ComboBox, DataTable, InlineNotification, Link as CarbonLink, MultiSelect, Pagination, Table, TableBatchAction, TableBatchActions, TableBody, TableCell,
  TableContainer, TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow, TableToolbar, TableToolbarContent, TableToolbarSearch,
} from '@carbon/react';
import { Filter, Link as LinkIcon, Merge, Split, TrashCan } from '@carbon/icons-react';
import { Link, useSearchParams } from 'react-router-dom';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { QueryBoundary } from '../components/QueryBoundary';
import { RunThumb } from '../components/RunPreview';
import { billingState, buildJobRows, formatDateTime, formatDuration, formatMoney, jobRowStatusOptions, nameFromFile, JobRowStatusTag, type BillingState, type JobRow } from '../derived';
import { AttachToJobModal } from '../dialogs/AttachToJobModal';
import { CreateSeparateJobsModal } from '../dialogs/CreateSeparateJobsModal';
import { DeleteSelectionModal } from '../dialogs/DeleteSelectionModal';
import { JobFormModal } from '../dialogs/JobFormModal';
import { matchesName, usageRowFromPrint } from '../dialogs/jobFormHelpers';
import { batchAvailability, outcomeFromRuns, runsSummary, sumReportedUsages, type BatchAction } from '../runs';
import { lookups, useNow, useSimulatedQuery, useStore } from '../store';
import type { Job, Machine, Print } from '../types';
import '../styles/jobs.scss';

type Option = { id: string; label: string };
type SortKey = 'job' | 'machine' | 'customer' | 'started' | 'price';

const billingOptions: Option[] = [
  { id: 'on_order', label: 'On an order' }, { id: 'order_outdated', label: 'Order outdated' }, { id: 'ready', label: 'Not on order' },
  { id: 'price_incomplete', label: 'Price incomplete' }, { id: 'pending', label: 'Price pending' },
];
const runOptions: Option[] = [{ id: 'manual', label: 'Manual' }, { id: 'printer', label: 'Recorded by printer' }];
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['status', 'machine', 'run', 'customer', 'operator', 'material', 'billing', 'from', 'to'] as const;
const HEADERS: { key: string; header: string; sort?: SortKey; narrow?: boolean }[] = [
  { key: 'job', header: 'Job', sort: 'job' },
  { key: 'machine', header: 'Machine', sort: 'machine', narrow: true },
  { key: 'customer', header: 'Customer', sort: 'customer', narrow: true },
  { key: 'status', header: 'Status' },
  { key: 'started', header: 'Started', sort: 'started', narrow: true },
  { key: 'price', header: 'Price', sort: 'price' },
];
const EMPTY: { jobs: Job[]; prints: Print[]; machines: Machine[] } = { jobs: [], prints: [], machines: [] };

const listParam = (value: string | null) => (value ?? '').split(',').filter(Boolean);
const selectedOptions = (options: Option[], ids: string[]) => options.filter((option) => ids.includes(option.id));

export function JobsPage() {
  const store = useStore();
  const materialOptions: Option[] = store.materials.map((material) => ({ id: material.id, label: material.name }));
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'started', direction: 'DESC' });
  const [jobOpen, setJobOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<BatchAction | null>(null);
  const now = useNow();
  const query = useSimulatedQuery((data) => ({ jobs: data.jobs, prints: data.prints, machines: data.machines }), EMPTY);

  const canCreate = store.can('machine_jobs.create');
  const selectable = canCreate || store.can('machine_jobs.edit') || store.can('machine_jobs.delete');

  const statusIds = listParam(params.get('status'));
  const machineIds = listParam(params.get('machine'));
  const runIds = listParam(params.get('run'));
  const materialIds = listParam(params.get('material'));
  const billingIds = listParam(params.get('billing'));
  const customerId = params.get('customer') ?? '';
  const operatorId = params.get('operator') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
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

  const machineOptions: Option[] = query.data.machines.map((machine) => ({ id: machine.id, label: machine.name }));
  const statusOptions: Option[] = jobRowStatusOptions;
  const allRows = useMemo(() => buildJobRows(query.data.jobs, query.data.prints, query.data.machines, now), [query.data, now]);

  const matches = (row: JobRow) => {
    const day = dateInAppTimeZone(row.startedAt);
    const text = [row.title, ...row.secondaryIds, row.machineName, row.customer, row.operator, row.job?.notes, ...row.materialNames].join(' ').toLowerCase();
    return (statusIds.length === 0 || statusIds.includes(row.status))
      && (machineIds.length === 0 || machineIds.includes(row.machineId))
      && (runIds.length === 0 || runIds.includes(row.run))
      && (!customerId || row.customerId === customerId)
      && (!operatorId || row.operatorId === operatorId)
      && (materialIds.length === 0 || materialIds.some((id) => row.materialIds.includes(id) || row.materialNames.includes(store.materials.find((material) => material.id === id)?.name ?? '')))
      && (billingIds.length === 0 || (row.job !== null && billingIds.includes(billingState(row.job) as BillingState)))
      && (!from || day >= from)
      && (!to || day <= to)
      && (!search || text.includes(search.toLowerCase()));
  };

  const sortValue = (row: JobRow, key: SortKey): string | number => {
    if (key === 'job') return row.title;
    if (key === 'machine') return row.machineName;
    if (key === 'customer') return row.customer ?? '';
    if (key === 'price') return row.price ?? -1;
    return row.startedAt;
  };
  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    return allRows.filter(matches).sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const result = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
      return result * direction;
    });
  }, [allRows, sort, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const rowsById = new Map(allRows.map((row) => [row.id, row]));
  const tableKey = `${page}-${pageSize}-${params.toString()}-${sort.key}-${sort.direction}`;

  // Selection survives paging and sorting; rows hidden by a filter drop out of it.
  const selectedRows = visible.filter((row) => selected.has(row.id));
  const selectedRuns = selectedRows.flatMap((row) => row.kind === 'print' && row.print ? [row.print] : []);
  const availability = batchAvailability(selectedRows, store.can);
  const unavailable = (Object.entries(availability) as [BatchAction, { enabled: boolean; reason: string | null }][]).filter(([, item]) => !item.enabled);
  const pageIds = pageRows.map((row) => row.id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    if (pageSelected === pageIds.length) pageIds.forEach((id) => next.delete(id)); else pageIds.forEach((id) => next.add(id));
    return next;
  });
  const clearSelection = () => setSelected(new Set());
  const combinedRuns = selectedRuns.length > 0 ? runsSummary(selectedRuns) : null;

  const tableRows = pageRows.map((row) => ({
    id: row.id, job: row.title, machine: row.machineName, customer: row.customer ?? '', status: row.status, started: row.startedAt, price: row.price ?? -1,
  }));
  const headers = HEADERS.map(({ key, header }) => ({ key, header }));
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'started' || key === 'price' ? 'DESC' : 'ASC' });

  const renderCell = (row: JobRow, key: string) => {
    if (key === 'job') {
      return (
        <div className="mj-title-with-thumb">
          <RunThumb run={row.print} />
          <div className="mj-cell-stack">
            <CarbonLink as={Link} to={row.href}>{row.title}</CarbonLink>
            <span className="mj-secondary">{row.secondaryIds.length ? row.secondaryIds.join(' · ') : row.job ? `${formatDuration(row.job.durationSeconds)} · manual run` : ''}</span>
            <span className="mj-secondary mj-show-narrow">{row.machineName}</span>
          </div>
        </div>
      );
    }
    if (key === 'machine') return row.machineName;
    if (key === 'customer') {
      return row.customer || row.operator
        ? <div className="mj-cell-stack"><span>{row.customer ?? '—'}</span>{row.operator && <span className="mj-secondary">{row.operator}</span>}</div>
        : '—';
    }
    if (key === 'status') return <JobRowStatusTag status={row.status} size="sm" />;
    if (key === 'started') return formatDateTime(row.startedAt);
    return formatMoney(row.price);
  };

  const emptyState = allRows.length === 0
    ? (
      <EmptyState
        title="No jobs yet" description="Jobs appear here when staff create them or when a printer records a run."
        action={canCreate ? <Button kind="tertiary" onClick={() => setJobOpen(true)}>New job</Button> : undefined}
      />
    )
    : (
      <EmptyState
        title="No jobs found" description="Try different search terms or filters."
        action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>}
      />
    );

  return (
    <PageShell
      title="Jobs" description="Running and finished jobs, and runs recorded by printers." width="wide"
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Jobs' }]}
    >
      <QueryBoundary query={query}>
        <DataTable key={tableKey} rows={tableRows} headers={headers}>
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => {
            return (
              <TableContainer className="mj-table-container">
                <TableToolbar className="mj-jobs-table-toolbar" aria-label="Jobs table toolbar">
                  {selectable && (
                    <TableBatchActions shouldShowBatchActions={selectedRows.length > 0} totalSelected={selectedRows.length} onCancel={clearSelection}>
                      <TableBatchAction renderIcon={TrashCan} disabled={!availability.delete.enabled} onClick={() => setBatch('delete')}>Delete</TableBatchAction>
                      <TableBatchAction renderIcon={Split} disabled={!availability.separate.enabled} onClick={() => setBatch('separate')}>Create separate jobs</TableBatchAction>
                      <TableBatchAction renderIcon={Merge} disabled={!availability.combined.enabled} onClick={() => setBatch('combined')}>Create combined job</TableBatchAction>
                      <TableBatchAction renderIcon={LinkIcon} disabled={!availability.attach.enabled} onClick={() => setBatch('attach')}>Attach to job</TableBatchAction>
                    </TableBatchActions>
                  )}
                  <TableToolbarContent>
                    <TableToolbarSearch
                      key={searchKey}
                      id="jobs-search"
                      labelText="Search jobs"
                      placeholder="Search jobs"
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
                      aria-controls="jobs-filters"
                      onClick={() => setFiltersOpen((open) => !open)}
                    />
                    {canCreate && <Button kind="primary" size="lg" onClick={() => setJobOpen(true)}>New job</Button>}
                  </TableToolbarContent>
                </TableToolbar>
                {filtersOpen && (
                  <div id="jobs-filters" className="mj-filter-panel" role="region" aria-label="Jobs filters">
                    <div className="mj-filter-panel__fields">
                      <MultiSelect id="jobs-status-filter" className="mj-filter-panel__field" titleText="Status" label="All statuses" items={statusOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(statusOptions, statusIds)} onChange={({ selectedItems }) => updateList('status', selectedItems)} />
                      <MultiSelect id="jobs-machine-filter" className="mj-filter-panel__field" titleText="Machine" label="All machines" items={machineOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(machineOptions, machineIds)} onChange={({ selectedItems }) => updateList('machine', selectedItems)} />
                      <MultiSelect id="jobs-run-filter" className="mj-filter-panel__field" titleText="Run source" label="All sources" items={runOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(runOptions, runIds)} onChange={({ selectedItems }) => updateList('run', selectedItems)} />
                      <ComboBox id="jobs-customer-filter" className="mj-filter-panel__field" titleText="Customer" placeholder="Any customer" items={lookups.people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={lookups.people.find((person) => person.id === customerId) ?? null} onChange={({ selectedItem }) => update({ customer: selectedItem?.id ?? null })} />
                      <ComboBox id="jobs-operator-filter" className="mj-filter-panel__field" titleText="Operator" placeholder="Any operator" items={lookups.operators} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={lookups.operators.find((operator) => operator.personId === operatorId) ?? null} onChange={({ selectedItem }) => update({ operator: selectedItem?.personId ?? null })} />
                      <MultiSelect id="jobs-material-filter" className="mj-filter-panel__field" titleText="Material" label="All materials" items={materialOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(materialOptions, materialIds)} onChange={({ selectedItems }) => updateList('material', selectedItems)} />
                      <MultiSelect id="jobs-billing-filter" className="mj-filter-panel__field" titleText="Billing state" label="All billing states" items={billingOptions} itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(billingOptions, billingIds)} onChange={({ selectedItems }) => updateList('billing', selectedItems)} />
                      <div className="mj-filter-panel__field"><DateInput id="jobs-from-filter" labelText="From" value={from} onChange={(value) => update({ from: value || null })} /></div>
                      <div className="mj-filter-panel__field"><DateInput id="jobs-to-filter" labelText="Through" value={to} onChange={(value) => update({ to: value || null })} /></div>
                      <Button kind="ghost" size="md" disabled={!hasActiveFilters} onClick={clearFilters}>Clear filters</Button>
                    </div>
                  </div>
                )}
                {selectable && selectedRows.length > 0 && unavailable.length > 0 && (
                  <InlineNotification kind="info" lowContrast hideCloseButton title="Some actions are unavailable for this selection">
                    <ul className="mj-skip-list">{unavailable.map(([action, item]) => <li key={action}>{item.reason}</li>)}</ul>
                  </InlineNotification>
                )}
                <Table {...getTableProps()} aria-label="Jobs">
                  <TableHead>
                    <TableRow>
                      {selectable && <TableSelectAll id="jobs-select-all" name="jobs-select-all" aria-label="Select all rows on this page" checked={pageIds.length > 0 && pageSelected === pageIds.length} indeterminate={pageSelected > 0 && pageSelected < pageIds.length} onSelect={togglePage} />}
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
                        <TableRow key={key} {...rowProps} isSelected={selected.has(row.id)}>
                          {selectable && <TableSelectRow id={`jobs-select-${row.id}`} name={`jobs-select-${row.id}`} aria-label={`Select ${row.title}`} checked={selected.has(row.id)} onSelect={() => toggle(row.id)} />}
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
            );
          }}
        </DataTable>
      </QueryBoundary>
      <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" />
      <DeleteSelectionModal open={batch === 'delete'} onClose={() => setBatch(null)} rows={selectedRows} onDone={clearSelection} />
      <CreateSeparateJobsModal open={batch === 'separate'} onClose={() => setBatch(null)} runs={selectedRuns} onDone={clearSelection} />
      <AttachToJobModal open={batch === 'attach'} onClose={() => setBatch(null)} runs={selectedRuns} onDone={clearSelection} />
      {batch === 'combined' && combinedRuns && (
        <JobFormModal
          open mode="create" onClose={() => setBatch(null)}
          initialValues={{
            title: nameFromFile(combinedRuns.first.fileName), printFileName: combinedRuns.first.fileName, machineId: combinedRuns.first.machineId, startsAt: combinedRuns.startsAt, endsAt: combinedRuns.endsAt,
            outcome: outcomeFromRuns(selectedRuns), usages: sumReportedUsages(selectedRuns).map((usage) => usageRowFromPrint(usage, store.spools)),
          }}
          onSaved={(job) => {
            store.attachRuns(selectedRuns.map((run) => run.id), job.id, { keepUsages: true });
            store.notify({ kind: 'success', title: `${selectedRuns.length} runs combined`, subtitle: `${job.displayId} holds all selected runs.`, action: { label: `View ${job.displayId}`, to: `/jobs/${job.id}` } });
            clearSelection();
          }}
        />
      )}
    </PageShell>
  );
}
