import { Add } from '@carbon/icons-react';
import { Button, ComboBox, DataTable, InlineNotification, Modal, Pagination, Search, Select, SelectItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPrintSubmission } from '../../api/generated/printing/printing';
import type { BillingParty, PrintSubmissionState } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatDateTime } from './formatting';
import { billingPartySearchQuery, machineLogbookKeys, machinesQuery, materialsQuery, spoolsQuery, submissionsQuery } from './queries';

type Fields = { machineId: string; customer: BillingParty | null; title: string; notes: string; ownership: 'makerspace' | 'external'; materialId: string; spoolId: string; externalMaterialName: string; estimatedQuantityG: string };

export function PrintSubmissionsPage() {
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 25);
  const form = useForm<Fields>({ defaultValues: { customer: null, ownership: 'makerspace' } });
  const ownership = form.watch('ownership');
  const submissions = useQuery(submissionsQuery({ search: params.get('search') || undefined, state: (params.get('state') || undefined) as PrintSubmissionState | undefined, page, pageSize }));
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: open });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: open });
  const spools = useQuery({ ...spoolsQuery({ lifecycle: 'active', page: 1, pageSize: 100 }), enabled: open && ownership === 'makerspace' });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: open });
  const mutation = useMutation({
    mutationFn: (values: Fields) => createPrintSubmission({
      machineId: values.machineId,
      customer: values.customer ? { kind: values.customer.kind, id: values.customer.id } : null,
      title: values.title,
      notes: values.notes || null,
      reprintsSubmissionId: null,
      declarations: values.estimatedQuantityG ? [{ ownership: values.ownership, materialId: values.ownership === 'makerspace' ? values.materialId || null : null, spoolId: values.ownership === 'makerspace' ? values.spoolId || null : null, externalMaterialName: values.ownership === 'external' ? values.externalMaterialName : null, estimatedQuantityG: values.estimatedQuantityG }] : [],
    }),
    onSuccess: async (created) => { setOpen(false); form.reset({ customer: null, ownership: 'makerspace' }); await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); navigate(`/machine-logbook/print-submissions/${created.id}`); },
  });
  const update = (key: string, value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.set('page', '1'); return next; });
  if (submissions.isPending) return <FullPageLoading label="Loading print submissions" />;
  if (submissions.isError) return <ErrorState message="Print submissions could not be loaded." onRetry={() => submissions.refetch()} />;
  const rows = submissions.data.items.map((item) => ({ id: item.id, displayId: item.displayId, title: item.title, machine: item.machineName, customer: item.customer ? `${item.customer.kind} · ${item.customer.id}` : 'Unassigned', state: item.state, created: formatDateTime(item.createdAt) }));
  const headers = [{ key: 'displayId', header: 'Submission' }, { key: 'title', header: 'Title' }, { key: 'machine', header: 'Printer' }, { key: 'customer', header: 'Customer' }, { key: 'state', header: 'State' }, { key: 'created', header: 'Created' }];
  return <PageShell title="Print submissions" description="Staff-reviewed print intake, attempts, and generic printer events." breadcrumbs={[{ label: 'Machines', to: '/machine-logbook' }, { label: 'Print submissions' }]} actions={hasPermission(currentUser, PermissionId.print_submissionsmanage) ? <Button renderIcon={Add} onClick={() => setOpen(true)}>New submission</Button> : undefined} width="wide" className="machine-logbook-page table-page">
    <div className="filter-bar"><Search labelText="Search print submissions" value={params.get('search') || ''} onChange={(event) => update('search', event.currentTarget.value)} /><Select id="submission-state" labelText="State" hideLabel value={params.get('state') || ''} onChange={(event) => update('state', event.target.value)}><SelectItem value="" text="All states" /><SelectItem value="queued" text="Queued" /><SelectItem value="in_progress" text="In progress" /><SelectItem value="completed" text="Completed" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /></Select></div>
    <DataTable rows={rows} headers={headers}>{({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer><Table {...getTableProps()} aria-label="Print submissions"><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{tableRows.map((row) => { const raw = rows.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id} className="clickable-row" onClick={() => navigate(`/machine-logbook/print-submissions/${row.id}`)}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'state' ? <Tag type={raw.state === 'completed' ? 'green' : raw.state === 'failed' ? 'red' : 'blue'}>{raw.state}</Tag> : cell.value as string}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10, 25, 50]} totalItems={submissions.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => { const next = new URLSearchParams(params); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); setParams(next); }} />
    <Modal open={open} size="lg" modalHeading="New print submission" primaryButtonText={mutation.isPending ? 'Creating…' : 'Create submission'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || machines.isPending} onRequestClose={() => setOpen(false)} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}><Stack gap={5}>
      <Select id="submission-machine" labelText="Printer" {...form.register('machineId', { required: true })}><SelectItem value="" text="Select a machine" />{machines.data?.items.filter((machine) => machine.status !== 'retired').map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}</Select>
      <Controller control={form.control} name="customer" render={({ field }) => <ComboBox id="submission-customer" titleText="Customer" items={parties.data?.items ?? []} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} placeholder="Search people or organizations…" />} />
      <TextInput id="submission-title" labelText="Title" {...form.register('title', { required: true })} /><TextArea id="submission-notes" labelText="Notes" {...form.register('notes')} />
      <h3>Filament declaration</h3><p className="section-description">Optional planning estimate. Actual usage is reviewed when a machine job is linked.</p>
      <Select id="declaration-ownership" labelText="Filament ownership" {...form.register('ownership')}><SelectItem value="makerspace" text="Makerspace stock" /><SelectItem value="external" text="Customer / external" /></Select>
      {ownership === 'makerspace' ? <><Select id="declaration-material" labelText="Material" {...form.register('materialId')}><SelectItem value="" text="Select material" />{materials.data?.items.filter((item) => item.unit === 'g').map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}</Select><Select id="declaration-spool" labelText="Spool (optional)" {...form.register('spoolId')}><SelectItem value="" text="No spool selected" />{spools.data?.items.map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId} · ${spool.materialName}`} />)}</Select></> : <TextInput id="declaration-external" labelText="External filament description" {...form.register('externalMaterialName')} />}
      <TextInput id="declaration-quantity" labelText="Estimated quantity (g)" {...form.register('estimatedQuantityG')} />
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Submission not created" subtitle="Check the printer, customer, and filament declaration." />}
    </Stack></Modal>
  </PageShell>;
}
