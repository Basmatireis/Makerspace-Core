import { Button, DataTable, Pagination, Search, Select, SelectItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import type { BillingStatus, MachineJobOutcome, MachineJobReviewState, MachineJobSource } from '../../api/generated/models';
import { BillingTag, OutcomeTag, ReviewTag } from './components';
import { CreateJobModal } from './CreateJobModal';
import { formatDateTime, formatDuration, formatMoney } from './formatting';
import { jobsQuery } from './queries';

const headers = [
  { key: 'displayId', header: 'ID' }, { key: 'startsAt', header: 'Date / time' }, { key: 'machine', header: 'Machine' },
  { key: 'customer', header: 'Customer' }, { key: 'operator', header: 'Operator' }, { key: 'usage', header: 'Material usage' },
  { key: 'duration', header: 'Duration' }, { key: 'outcome', header: 'Outcome' }, { key: 'price', header: 'Effective price' }, { key: 'billing', header: 'Billing' },
];

function dateBoundary(value: string | null, end: boolean) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function JobsPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
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
    billingStatus: (params.get('billing') || undefined) as BillingStatus | undefined,
    source: (params.get('source') || undefined) as MachineJobSource | undefined,
    reviewState: (params.get('review') || undefined) as MachineJobReviewState | undefined,
    from: dateBoundary(params.get('from'), false),
    to: dateBoundary(params.get('to'), true),
    page, pageSize,
  };
  const query = useQuery(jobsQuery(filters));
  const update = (key: string, value?: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.set('page', '1'); return next; });
  const closeCreate = () => { setCreateOpen(false); setParams((current) => { const next = new URLSearchParams(current); next.delete('new'); return next; }, { replace: true }); };
  if (query.isPending) return <FullPageLoading label="Loading jobs" />;
  if (query.isError) return <ErrorState message="Jobs could not be loaded." onRetry={() => query.refetch()} />;
  const rows = query.data.items.map((job) => ({ id: job.id, displayId: job.displayId, startsAt: formatDateTime(job.startsAt), machine: job.machine.name, customer: job.customer?.displayName ?? 'Unassigned', operator: job.operator?.displayName ?? 'Unassigned', usage: job.usages.length ? job.usages.map((usage) => `${usage.quantity} ${usage.unit} ${usage.materialName}`).join(', ') : '—', duration: formatDuration(job.durationSeconds), outcome: job.outcome, price: formatMoney(job.effectivePrice), billing: job.billingStatus, review: job.reviewState }));
  const machineOptions = [...new Map(query.data.items.map((job) => [job.machine.id, job.machine.name])).entries()];
  const customerOptions = [...new Map(query.data.items.filter((job) => job.customer).map((job) => [job.customer!.id, job.customer!.displayName])).entries()];
  const operatorOptions = [...new Map(query.data.items.filter((job) => job.operator).map((job) => [job.operator!.personId, job.operator!.displayName])).entries()];
  const materialOptions = [...new Map(query.data.items.flatMap((job) => job.usages.map((usage) => [usage.materialId, usage.materialName] as const))).entries()];

  return <Stack gap={7} className="machine-logbook-page table-page">
    <PageHeader title="Jobs" description={`${query.data.total} machine jobs`} breadcrumbs={[{ label: 'Machine logbook', to: '/machine-logbook' }, { label: 'Jobs' }]} actions={hasPermission(currentUser, PermissionId.machine_jobscreate) ? <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>New job</Button> : undefined} />
    <div className="filter-bar jobs-filter-bar">
      <Search labelText="Search jobs, customers, machines, operators, or materials" value={filters.search ?? ''} onChange={(event) => update('search', event.currentTarget.value)} />
      <Select id="job-machine" labelText="Machine" value={params.get('machine') || ''} onChange={(e) => update('machine', e.target.value)}><SelectItem value="" text="All machines" />{machineOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <Select id="job-customer" labelText="Customer" value={params.get('customer') || ''} onChange={(e) => update('customer', e.target.value)}><SelectItem value="" text="All customers" />{customerOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <Select id="job-operator" labelText="Operator" value={params.get('operator') || ''} onChange={(e) => update('operator', e.target.value)}><SelectItem value="" text="All operators" />{operatorOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <Select id="job-material" labelText="Material" value={params.get('material') || ''} onChange={(e) => update('material', e.target.value)}><SelectItem value="" text="All materials" />{materialOptions.map(([id, label]) => <SelectItem key={id} value={id} text={label} />)}</Select>
      <Select id="job-outcome" labelText="Outcome" hideLabel value={filters.outcome ?? ''} onChange={(e) => update('outcome', e.target.value)}><SelectItem value="" text="All outcomes" /><SelectItem value="successful" text="Successful" /><SelectItem value="partial_failure" text="Partial failure" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /><SelectItem value="unknown" text="Unknown" /></Select>
      <Select id="job-billing" labelText="Billing" hideLabel value={filters.billingStatus ?? ''} onChange={(e) => update('billing', e.target.value)}><SelectItem value="" text="All billing" /><SelectItem value="unbilled" text="Unbilled" /><SelectItem value="billed" text="Billed" /><SelectItem value="waived" text="Waived" /></Select>
      <Select id="job-source" labelText="Source" hideLabel value={filters.source ?? ''} onChange={(e) => update('source', e.target.value)}><SelectItem value="" text="All sources" /><SelectItem value="manual" text="Manual" /><SelectItem value="automatic" text="Automatic" /></Select>
      <Select id="job-review" labelText="Review" hideLabel value={filters.reviewState ?? ''} onChange={(e) => update('review', e.target.value)}><SelectItem value="" text="All review states" /><SelectItem value="needs_review" text="Needs review" /><SelectItem value="confirmed" text="Confirmed" /></Select>
      <TextInput id="job-from" type="date" labelText="From" value={params.get('from') || ''} onChange={(e) => update('from', e.currentTarget.value)} />
      <TextInput id="job-to" type="date" labelText="Through" value={params.get('to') || ''} onChange={(e) => update('to', e.currentTarget.value)} />
    </div>
    <DataTable rows={rows} headers={headers}>{({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer><Table {...getTableProps()} tabIndex={0} aria-label="Machine jobs"><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{tableRows.map((row) => { const raw = rows.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id} className="clickable-row" onClick={() => navigate(`/machine-logbook/jobs/${row.id}`)}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'outcome' ? <OutcomeTag outcome={raw.outcome} /> : cell.info.header === 'billing' ? <BillingTag status={raw.billing} /> : cell.info.header === 'displayId' ? <span className="job-id-cell">{cell.value as string}<ReviewTag state={raw.review} /></span> : cell.info.header === 'customer' && raw.customer === 'Unassigned' ? <Tag type="red">Unassigned</Tag> : cell.value as string}</TableCell>)}</TableRow>;})}</TableBody></Table></TableContainer>}</DataTable>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10,25,50,100]} totalItems={query.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => { const next = new URLSearchParams(params); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); setParams(next); }} />
    {createOpen && <CreateJobModal open onClose={closeCreate} />}
  </Stack>;
}
