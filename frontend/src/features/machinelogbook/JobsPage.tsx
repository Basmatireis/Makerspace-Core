import './styles.scss';
import './jobs.scss';
import { Button, ComboBox, DataTable, Pagination, Search, Select, SelectItem, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, Tile, StructuredListWrapper, StructuredListBody } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { DetailRow } from '../../app/DetailSection';
import { DateInput } from '../../app/DateInput';
import { addCalendarDays, zonedDateTimeToISO } from '../../app/dateTime';
import { PermissionId, canLookupJobParties, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import type { MachineJobOutcome, MachineJobReviewState, MachineJobSource } from '../../api/generated/models';
import { OutcomeTag, ReviewTag } from './components';
import { CreateJobModal } from './CreateJobModal';
import { formatDateTime, formatDuration, formatMoney } from './formatting';
import { billingPartySearchQuery, jobsQuery, machinesQuery, materialsQuery, operatorSearchQuery } from './queries';

const headers = [
  { key: 'displayId', header: 'ID' }, { key: 'startsAt', header: 'Date / time' }, { key: 'machine', header: 'Machine' },
  { key: 'customer', header: 'Customer' }, { key: 'operator', header: 'Operator' }, { key: 'usage', header: 'Material usage' },
  { key: 'duration', header: 'Duration' }, { key: 'outcome', header: 'Outcome' }, { key: 'price', header: 'Effective price' },
];

function dateBoundary(value: string | null, end: boolean) {
  if (!value) return undefined;
  return zonedDateTimeToISO(end ? addCalendarDays(value, 1) : value, '00:00');
}

export function JobsPage() {
  const currentUser = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1' && hasPermission(currentUser, PermissionId.machine_jobscreate));
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 25);
  const filters = {
    search: params.get('search') || undefined,
    machineId: params.get('machine') || undefined,
    customerId: params.get('customer') || undefined,
    operatorPersonId: params.get('operator') || undefined,
    materialId: params.get('material') || undefined,
    outcome: (params.get('outcome') || undefined) as MachineJobOutcome | undefined,
    source: (params.get('source') || undefined) as MachineJobSource | undefined,
    reviewState: (params.get('review') || undefined) as MachineJobReviewState | undefined,
    from: dateBoundary(params.get('from'), false),
    to: dateBoundary(params.get('to'), true),
    page, pageSize,
  };
  const query = useQuery({ ...jobsQuery(filters), placeholderData: keepPreviousData });
  const canReadMachines = hasPermission(currentUser, PermissionId.machinesread);
  const canReadInventory = hasPermission(currentUser, PermissionId.inventoryread);
  const canLookup = canLookupJobParties(currentUser);
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  // Filter choices come from the catalog, not from the jobs on the current page.
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: canReadMachines });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: canReadInventory });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: canLookup, placeholderData: keepPreviousData });
  const update = (key: string, value?: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.set('page', '1'); return next; }, { replace: true });
  const closeCreate = () => { setCreateOpen(false); setParams((current) => { const next = new URLSearchParams(current); next.delete('new'); return next; }, { replace: true }); };
  if (query.isPending) return <FullPageLoading label="Loading jobs" />;
  if (!query.data) return <ErrorState message="Jobs could not be loaded." onRetry={() => query.refetch()} />;
  const rows = query.data.items.map((job) => ({ id: job.id, displayId: job.displayId, startsAt: formatDateTime(job.startsAt), machine: job.machine.name, customer: job.customer?.displayName ?? 'Unassigned', operator: job.operator?.displayName ?? 'Unassigned', usage: job.usages.length ? job.usages.map((usage) => `${usage.quantity} ${usage.unit} ${usage.materialName}`).join(', ') : '—', duration: formatDuration(job.durationSeconds), outcome: job.outcome, price: formatMoney(job.effectivePrice), review: job.reviewState }));
  const pageMachines = query.data.items.map((job) => [job.machine.id, job.machine.name] as const);
  const pageCustomers = query.data.items.filter((job) => job.customer).map((job) => [job.customer!.id, job.customer!.displayName] as const);
  const pageOperators = query.data.items.filter((job) => job.operator).map((job) => [job.operator!.personId, job.operator!.displayName] as const);
  const pageMaterials = query.data.items.flatMap((job) => job.usages.filter((usage) => usage.materialId).map((usage) => [usage.materialId!, usage.materialName] as const));
  // Without catalog access, fall back to what the current page shows.
  const machineOptions = [...new Map(machines.data ? machines.data.items.map((item) => [item.id, item.name] as const) : pageMachines).entries()];
  const materialOptions = [...new Map(materials.data ? materials.data.items.map((item) => [item.id, item.name] as const) : pageMaterials).entries()];
  const customerOptions = [...new Map([...pageCustomers, ...(parties.data?.items.map((item) => [item.id, item.displayName] as const) ?? [])]).entries()].map(([id, label]) => ({ id, label }));
  const operatorOptions = [...new Map([...pageOperators, ...(operators.data?.items.map((item) => [item.personId, item.displayName] as const) ?? [])]).entries()].map(([id, label]) => ({ id, label }));
  // A filtered result set names the selected party, so the label survives a reload.
  const selectedCustomer = customerOptions.find((item) => item.id === params.get('customer')) ?? null;
  const selectedOperator = operatorOptions.find((item) => item.id === params.get('operator')) ?? null;

  return <PageShell title="Jobs" description={`${query.data.total} machine jobs`} breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Jobs' }]} actions={hasPermission(currentUser, PermissionId.machine_jobscreate) ? <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>New job</Button> : undefined} width="wide" className="machine-logbook-page table-page jobs-page">
    <div className="filter-bar jobs-filter-bar">
      <Search labelText="Search jobs, customers, machines, operators, or materials" value={filters.search ?? ''} onChange={(event) => update('search', event.currentTarget.value)} />
      <Select id="job-machine" labelText="Machine" value={params.get('machine') || ''} onChange={(e) => update('machine', e.target.value)}><SelectItem value="" text="All machines" />{machineOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <ComboBox id="job-customer" titleText="Customer" placeholder="All customers" items={customerOptions} itemToString={(item) => item?.label ?? ''} selectedItem={selectedCustomer} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => update('customer', selectedItem?.id)} />
      <ComboBox id="job-operator" titleText="Operator" placeholder="All operators" items={operatorOptions} itemToString={(item) => item?.label ?? ''} selectedItem={selectedOperator} onInputChange={setOperatorSearch} onChange={({ selectedItem }) => update('operator', selectedItem?.id)} />
      <Select id="job-material" labelText="Material" value={params.get('material') || ''} onChange={(e) => update('material', e.target.value)}><SelectItem value="" text="All materials" />{materialOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <Select id="job-outcome" labelText="Outcome" hideLabel value={filters.outcome ?? ''} onChange={(e) => update('outcome', e.target.value)}><SelectItem value="" text="All outcomes" /><SelectItem value="successful" text="Successful" /><SelectItem value="partial_failure" text="Partial failure" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /><SelectItem value="unknown" text="Unknown" /></Select>
      <Select id="job-source" labelText="Source" hideLabel value={filters.source ?? ''} onChange={(e) => update('source', e.target.value)}><SelectItem value="" text="All sources" /><SelectItem value="manual" text="Manual" /><SelectItem value="automatic" text="Automatic" /></Select>
      <Select id="job-review" labelText="Review" hideLabel value={filters.reviewState ?? ''} onChange={(e) => update('review', e.target.value)}><SelectItem value="" text="All review states" /><SelectItem value="needs_review" text="Needs review" /><SelectItem value="confirmed" text="Confirmed" /></Select>
      <DateInput id="job-from" labelText="From" value={params.get('from') || ''} onChange={(value) => update('from', value)} />
      <DateInput id="job-to" labelText="Through" value={params.get('to') || ''} onChange={(value) => update('to', value)} />
    </div>
    {rows.length === 0 && <EmptyState title="No jobs found" description="Try different filters or create a manual job." />}
    <div className="jobs-table"><DataTable rows={rows} headers={headers}>{({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer><Table {...getTableProps()} tabIndex={0} aria-label="Machine jobs"><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{tableRows.map((row) => { const raw = rows.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'outcome' ? <OutcomeTag outcome={raw.outcome} /> : cell.info.header === 'displayId' ? <span className="job-id-cell"><Link to={`/machine-logbook/jobs/${row.id}`}>{cell.value as string}</Link><ReviewTag state={raw.review} /></span> : cell.info.header === 'customer' && raw.customer === 'Unassigned' ? <Tag type="red">Unassigned</Tag> : cell.value as string}</TableCell>)}</TableRow>;})}</TableBody></Table></TableContainer>}</DataTable></div>
    <div className="jobs-cards">{rows.map((job) => <Tile key={job.id}><h2><Link to={`/machine-logbook/jobs/${job.id}`}>{job.displayId}</Link></h2><ReviewTag state={job.review} /><OutcomeTag outcome={job.outcome} /><StructuredListWrapper isCondensed><StructuredListBody>{[['Date / time', job.startsAt], ['Machine', job.machine], ['Customer', job.customer], ['Operator', job.operator], ['Material usage', job.usage], ['Duration', job.duration], ['Effective price', job.price]].map(([label, value]) => <DetailRow key={label} label={label} value={value} />)}</StructuredListBody></StructuredListWrapper></Tile>)}</div>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10,25,50,100]} totalItems={query.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => { const next = new URLSearchParams(params); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); setParams(next); }} />
    {createOpen && <CreateJobModal open onClose={closeCreate} />}
  </PageShell>;
}
