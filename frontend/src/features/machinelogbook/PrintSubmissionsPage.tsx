import { CatalogFormModal } from './CatalogFormModal';
import { useLatestCallback } from '../../app/useLatestCallback';
import './styles.scss';
import './catalog.scss';
import { Add } from '@carbon/icons-react';
import { Button, ComboBox, DataTable, InlineNotification, Pagination, Search, Select, SelectItem, Stack, StructuredListBody, StructuredListWrapper, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextArea, TextInput, Tile } from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createPrintSubmission } from '../../api/generated/printing/printing';
import type { BillingParty, PrintSubmissionState } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canLookupJobParties, hasPermission, PermissionId } from '../auth/permissions';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { DetailRow } from '../../app/DetailSection';
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
  const [machineSearch, setMachineSearch] = useState('');
  const [machinePage, setMachinePage] = useState(1);
  const canReadMachines = hasPermission(currentUser, PermissionId.machinesread);
  const canReadInventory = hasPermission(currentUser, PermissionId.inventoryread);
  const canReadParties = canLookupJobParties(currentUser);
  const canManage = hasPermission(currentUser, PermissionId.print_submissionsmanage);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = [10, 25, 50].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 25;
  const form = useForm<Fields>({ defaultValues: { machineId: '', customer: null, title: '', notes: '', ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', estimatedQuantityG: '' } });
  const ownership = form.watch('ownership');
  const guard = useUnsavedChanges({ isDirty: open && form.formState.isDirty, onDiscard: () => { form.reset(); setOpen(false); } });
  const submissions = useQuery({ ...submissionsQuery({ search: params.get('search') || undefined, state: (params.get('state') || undefined) as PrintSubmissionState | undefined, page, pageSize }), placeholderData: keepPreviousData });
  const machines = useQuery({ ...machinesQuery({ search: machineSearch || undefined, page: machinePage, pageSize: 25 }), enabled: open && canReadMachines });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: open && canReadInventory && ownership === 'makerspace' });
  const spools = useQuery({ ...spoolsQuery({ lifecycle: 'active', page: 1, pageSize: 100 }), enabled: open && canReadInventory && ownership === 'makerspace' });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: open && canReadParties });
  const mutation = useMutation({
    mutationFn: (values: Fields) => createPrintSubmission({
      machineId: values.machineId,
      customer: values.customer ? { kind: values.customer.kind, id: values.customer.id } : null,
      title: values.title,
      notes: values.notes || null,
      reprintsSubmissionId: null,
      declarations: values.estimatedQuantityG ? [{ ownership: values.ownership, materialId: values.ownership === 'makerspace' ? values.materialId || null : null, spoolId: values.ownership === 'makerspace' ? values.spoolId || null : null, externalMaterialName: values.ownership === 'external' ? values.externalMaterialName : null, estimatedQuantityG: values.estimatedQuantityG }] : [],
    }),
    onSuccess: async (created) => { setOpen(false); form.reset({ customer: null, ownership: 'makerspace' }); await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); guard.bypassAfterSubmit(() => navigate(`/machine-logbook/print-submissions/${created.id}`)); },
  });
  const close = useLatestCallback(() => { if (!mutation.isPending) guard.requestDiscard(() => { form.reset(); setOpen(false); }); });
  const update = (key: string, value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.set('page', '1'); return next; }, { replace: true });
  if (submissions.isPending) return <FullPageLoading label="Loading print submissions" />;
  if (!submissions.data) return <ErrorState message="Print submissions could not be loaded." onRetry={() => submissions.refetch()} />;
  const rows = submissions.data.items.map((item) => ({ id: item.id, displayId: item.displayId, title: item.title, machine: item.machineName, customer: item.customer ? item.customerDisplayName ?? 'Unknown customer' : 'Unassigned', state: item.state, created: formatDateTime(item.createdAt) }));
  const headers = [{ key: 'displayId', header: 'Submission' }, { key: 'title', header: 'Title' }, { key: 'machine', header: 'Printer' }, { key: 'customer', header: 'Customer' }, { key: 'state', header: 'State' }, { key: 'created', header: 'Created' }];
  return <PageShell title="Print submissions" description="Staff-reviewed print intake, attempts, and generic printer events." breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Print submissions' }]} actions={canManage ? <Button renderIcon={Add} onClick={() => { mutation.reset(); setOpen(true); }}>New submission</Button> : undefined} width="wide" className="machine-logbook-page table-page machine-catalog">
    <div className="filter-bar"><Search labelText="Search print submissions" value={params.get('search') || ''} onChange={(event) => update('search', event.currentTarget.value)} /><Select id="submission-state" labelText="State" hideLabel value={params.get('state') || ''} onChange={(event) => update('state', event.target.value)}><SelectItem value="" text="All states" /><SelectItem value="queued" text="Queued" /><SelectItem value="in_progress" text="In progress" /><SelectItem value="completed" text="Completed" /><SelectItem value="failed" text="Failed" /><SelectItem value="cancelled" text="Cancelled" /></Select></div>
    {rows.length === 0 && <EmptyState title="No print submissions" description="Try another filter or create a submission." />}
    <div className="catalog-table"><DataTable rows={rows} headers={headers}>{({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer><Table {...getTableProps()} aria-label="Print submissions"><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{tableRows.map((row) => { const raw = rows.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'displayId' ? <Link to={`/machine-logbook/print-submissions/${row.id}`}>{raw.displayId}</Link> : cell.info.header === 'state' ? <Tag type={raw.state === 'completed' ? 'green' : raw.state === 'failed' ? 'red' : 'blue'}>{raw.state}</Tag> : cell.value as string}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable></div>
    <div className="catalog-cards">{rows.map((item) => <Tile key={item.id}><h2><Link to={`/machine-logbook/print-submissions/${item.id}`}>{item.displayId}</Link></h2><p>{item.title}</p><Tag type={item.state === 'completed' ? 'green' : item.state === 'failed' ? 'red' : 'blue'}>{item.state}</Tag><StructuredListWrapper isCondensed><StructuredListBody><DetailRow label="Printer" value={item.machine} /><DetailRow label="Customer" value={item.customer} /><DetailRow label="Created" value={item.created} /></StructuredListBody></StructuredListWrapper></Tile>)}</div>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10, 25, 50]} totalItems={submissions.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => { const next = new URLSearchParams(params); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); setParams(next); }} />
    {open && <CatalogFormModal open={!guard.dialogOpen} size="lg" selectorPrimaryFocus="#submission-machine" modalHeading="New print submission" primaryButtonText={mutation.isPending ? 'Creating…' : 'Create submission'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || !canReadMachines || machines.isPending || machines.isError || (!!form.watch('estimatedQuantityG') && ownership === 'makerspace' && !canReadInventory)} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending && canManage && canReadMachines && machines.isSuccess && (!values.estimatedQuantityG || values.ownership !== 'makerspace' || canReadInventory)) mutation.mutate(values); })}><Stack gap={5}>
      {!canReadMachines && <InlineNotification kind="info" hideCloseButton title="Machine access required" subtitle="Machine read permission is required to select a printer and create a submission." />}
      {canReadMachines && <Search labelText="Search printers" value={machineSearch} onChange={(event) => { setMachineSearch(event.currentTarget.value); setMachinePage(1); form.setValue('machineId', ''); }} />}
      <Select disabled={!canReadMachines} id="submission-machine" labelText="Printer" invalid={!!form.formState.errors.machineId} invalidText="Select a printer." {...form.register('machineId', { required: true })}><SelectItem value="" text="Select a machine" />{machines.data?.items.filter((machine) => machine.status !== 'retired').map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}</Select>
      {canReadMachines && machines.data && <Pagination page={machinePage} pageSize={25} pageSizes={[25]} totalItems={machines.data.total} onChange={({ page }) => { form.setValue('machineId', ''); setMachinePage(page); }} />}
      {machines.isError && <ErrorState message="Printers could not be loaded." onRetry={() => machines.refetch()} />}
      {!canReadParties && <p className="section-description">Customer lookup is unavailable with your permissions. The submission can remain unassigned.</p>}
      {canReadParties && <Controller control={form.control} name="customer" render={({ field }) => <ComboBox id="submission-customer" titleText="Customer" items={parties.data?.items ?? []} itemToString={(item) => item?.displayName ?? ''} selectedItem={field.value} onInputChange={setCustomerSearch} onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)} placeholder="Search people or organizations…" />} />}
      {parties.isError && <ErrorState message="Customers could not be loaded." onRetry={() => parties.refetch()} />}
      <TextInput id="submission-title" labelText="Title" invalid={!!form.formState.errors.title} invalidText="Enter a title." {...form.register('title', { required: true, validate: (value) => !!value.trim() })} /><TextArea id="submission-notes" labelText="Notes" {...form.register('notes')} />
      <h3>Filament declaration</h3><p className="section-description">Optional planning estimate. Actual usage is reviewed when a machine job is linked.</p>
      <Select id="declaration-ownership" labelText="Filament ownership" {...form.register('ownership')}><SelectItem value="makerspace" text="Makerspace stock" /><SelectItem value="external" text="Customer / external" /></Select>
      {ownership === 'makerspace' ? <>{!canReadInventory && <InlineNotification kind="info" hideCloseButton title="Inventory access required" subtitle="Inventory read permission is needed for a makerspace filament declaration. Omit the estimate or choose external filament." />}<Select disabled={!canReadInventory} id="declaration-material" labelText="Material" {...form.register('materialId')}><SelectItem value="" text="Select material" />{materials.data?.items.filter((item) => item.unit === 'g').map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}</Select><Select disabled={!canReadInventory} id="declaration-spool" labelText="Spool (optional)" {...form.register('spoolId')}><SelectItem value="" text="No spool selected" />{spools.data?.items.map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId} · ${spool.materialName}`} />)}</Select></> : <TextInput id="declaration-external" labelText="External filament description" {...form.register('externalMaterialName')} />}
      {(materials.isError || spools.isError) && <InlineNotification kind="error" hideCloseButton title="Inventory could not be loaded" subtitle="Close and reopen the dialog to retry." />}
      <TextInput id="declaration-quantity" labelText="Estimated quantity (g)" {...form.register('estimatedQuantityG')} />
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Submission not created" subtitle="Check the printer, customer, and filament declaration." />}
    </Stack></CatalogFormModal>}<UnsavedChangesDialog guard={guard} />
  </PageShell>;
}
