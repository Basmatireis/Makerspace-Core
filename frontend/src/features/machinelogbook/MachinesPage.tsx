import './styles.scss';
import './catalog.scss';
import { Add } from '@carbon/icons-react';
import { Button, Pagination, Search, Select, SelectItem, StructuredListBody, StructuredListWrapper, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, Tile } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Machine, MachineStatus, MachineType } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { DetailRow, DetailSection } from '../../app/DetailSection';
import { RowActions } from '../../app/RowActions';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { formatDateTime, formatDecimal, formatDuration } from './formatting';
import { machineTypesQuery, machinesQuery } from './queries';
import { MachineEditor, MachineTypeEditor } from './MachineEditor';

export function MachinesPage() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.machinesmanage);
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = [10, 25, 50].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 25;
  const status = ['active', 'maintenance', 'retired'].includes(params.get('status') ?? '') ? params.get('status') as MachineStatus : undefined;
  const machines = useQuery({ ...machinesQuery({ search: params.get('search') || undefined, status, page, pageSize }), placeholderData: keepPreviousData });
  const types = useQuery({ ...machineTypesQuery(), enabled: canManage });
  const [editor, setEditor] = useState<{ kind: 'machine'; value?: Machine } | { kind: 'type'; value?: MachineType } | null>(null);
  const update = (key: string, value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); next.set('page', '1'); return next; }, { replace: true });
  if (machines.isPending) return <FullPageLoading label="Loading machines" />;
  if (!machines.data) return <ErrorState message="Machines could not be loaded." onRetry={() => machines.refetch()} />;
  const machineLink = (item: Machine) => <Link to={`/machine-logbook/machines/${item.id}`}>{item.name}</Link>;
  const actions = (item: Machine) => canManage && <RowActions label={`Actions for ${item.name}`}><Button kind="ghost" size="sm" onClick={() => setEditor({ kind: 'machine', value: item })}>Edit</Button></RowActions>;
  return <PageShell title="Machines" description={`${machines.data.total} machines · statuses are administrative, not live telemetry`} breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Machines' }]} actions={canManage && <><Button kind="secondary" onClick={() => setEditor({ kind: 'type' })}>Add type</Button><Button renderIcon={Add} onClick={() => setEditor({ kind: 'machine' })}>Add machine</Button></>} width="wide" className="machine-logbook-page table-page machine-catalog">
    <div className="filter-bar"><Search labelText="Search machines" value={params.get('search') || ''} onChange={(event) => update('search', event.currentTarget.value)} /><Select id="machines-status" labelText="Machine status" hideLabel value={status ?? ''} onChange={(event) => update('status', event.target.value)}><SelectItem value="" text="All statuses" /><SelectItem value="active" text="Active" /><SelectItem value="maintenance" text="Maintenance" /><SelectItem value="retired" text="Retired" /></Select></div>
    {!machines.data.items.length ? <EmptyState title="No machines found" description="Try another search or status filter." /> : <>
      <div className="catalog-table"><TableContainer><Table aria-label="Machines"><TableHead><TableRow>{['Machine', 'Type', 'Status', 'Total runtime', 'Jobs', 'Failure rate', 'Collection', 'Last ingest', ...(canManage ? ['Actions'] : [])].map((heading) => <TableHeader key={heading}>{heading}</TableHeader>)}</TableRow></TableHead><TableBody>{machines.data.items.map((item) => <TableRow key={item.id}><TableCell>{machineLink(item)}</TableCell><TableCell>{item.machineType.name}</TableCell><TableCell><Tag type={item.status === 'active' ? 'green' : 'gray'}>{item.status}</Tag></TableCell><TableCell>{formatDuration(item.runtimeSeconds)}</TableCell><TableCell>{item.jobCount}</TableCell><TableCell>{formatDecimal(item.failureRate)}%</TableCell><TableCell>{item.automaticCollectionEnabled ? 'Automatic' : 'Manual only'}</TableCell><TableCell>{item.lastIngestedAt ? formatDateTime(item.lastIngestedAt) : '—'}</TableCell>{canManage && <TableCell>{actions(item)}</TableCell>}</TableRow>)}</TableBody></Table></TableContainer></div>
      <div className="catalog-cards">{machines.data.items.map((item) => <Tile key={item.id}><h2 className="catalog-card-title">{machineLink(item)}</h2><Tag type={item.status === 'active' ? 'green' : 'gray'}>{item.status}</Tag><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Type" value={item.machineType.name} /><DetailRow label="Total runtime" value={formatDuration(item.runtimeSeconds)} /><DetailRow label="Jobs" value={item.jobCount} /><DetailRow label="Failure rate" value={`${formatDecimal(item.failureRate)}%`} /><DetailRow label="Collection" value={item.automaticCollectionEnabled ? 'Automatic' : 'Manual only'} /><DetailRow label="Last ingest" value={item.lastIngestedAt ? formatDateTime(item.lastIngestedAt) : '—'} /></StructuredListBody></StructuredListWrapper>{actions(item)}</Tile>)}</div>
    </>}
    <Pagination page={page} pageSize={pageSize} pageSizes={[10, 25, 50]} totalItems={machines.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => setParams((current) => { const next = new URLSearchParams(current); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); return next; })} />
    {canManage && <DetailSection title="Machine types" description="Inactive types remain attached to existing machines and are unavailable for new machines.">{types.isPending ? <p>Loading machine types…</p> : types.isError ? <ErrorState message="Machine types could not be loaded." onRetry={() => types.refetch()} /> : <div className="catalog-types">{types.data.items.map((type) => <Tile key={type.id}><h3>{type.name}</h3><Tag type={type.active ? 'green' : 'gray'}>{type.active ? 'Active' : 'Inactive'}</Tag><Button kind="ghost" size="sm" aria-label={`Edit type ${type.name}`} onClick={() => setEditor({ kind: 'type', value: type })}>Edit type</Button></Tile>)}</div>}</DetailSection>}
    {editor?.kind === 'machine' && <MachineEditor machine={editor.value} onClose={() => setEditor(null)} />}{editor?.kind === 'type' && <MachineTypeEditor type={editor.value} onClose={() => setEditor(null)} />}
  </PageShell>;
}
