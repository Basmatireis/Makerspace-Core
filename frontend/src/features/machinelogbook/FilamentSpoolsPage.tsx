import { Add } from '@carbon/icons-react';
import {
  Button, DataTable, InlineNotification, Modal, Pagination, Search, Select, SelectItem, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createFilamentSpool } from '../../api/generated/filament-spools/filament-spools';
import type { FilamentSpoolLifecycle } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatDecimal } from './formatting';
import { machineLogbookKeys, materialsQuery, spoolsQuery } from './queries';

type SpoolFields = {
  materialId: string;
  initialNetWeightG: string;
  stockMode: 'new_acquisition' | 'existing_stock';
  totalPrice: string;
  manufacturer: string;
  productName: string;
  tareWeightG: string;
  acquisitionReference: string;
  storageLocation: string;
  notes: string;
};

const lifecycleTag = (lifecycle: FilamentSpoolLifecycle) => (
  <Tag type={lifecycle === 'active' ? 'green' : 'warm-gray'}>{lifecycle}</Tag>
);

export function FilamentSpoolsPage() {
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 25);
  const form = useForm<SpoolFields>({ defaultValues: { stockMode: 'existing_stock' } });
  const query = useQuery(spoolsQuery({
    search: params.get('search') || undefined,
    lifecycle: (params.get('lifecycle') || undefined) as FilamentSpoolLifecycle | undefined,
    page,
    pageSize,
  }));
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: createOpen });
  const mutation = useMutation({
    mutationFn: (values: SpoolFields) => {
      const material = materials.data!.items.find((item) => item.id === values.materialId)!;
      return createFilamentSpool({
        materialId: values.materialId,
        initialNetWeightG: values.initialNetWeightG,
        stockMode: values.stockMode,
        totalPrice: values.stockMode === 'new_acquisition' ? values.totalPrice : null,
        manufacturer: values.manufacturer || null,
        productName: values.productName || null,
        tareWeightG: values.tareWeightG || null,
        acquiredOn: null,
        acquisitionReference: values.acquisitionReference || null,
        storageLocation: values.storageLocation || null,
        notes: values.notes || null,
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
      });
    },
    onSuccess: async (created) => {
      setCreateOpen(false);
      form.reset({ stockMode: 'existing_stock' });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      navigate(`/machine-logbook/spools/${created.id}`);
    },
  });
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    return next;
  });

  if (query.isPending) return <FullPageLoading label="Loading filament spools" />;
  if (query.isError) return <ErrorState message="Filament spools could not be loaded." onRetry={() => query.refetch()} />;
  const rows = query.data.items.map((spool) => ({
    id: spool.id,
    displayId: spool.displayId,
    material: spool.materialName,
    product: [spool.manufacturer, spool.productName].filter(Boolean).join(' · ') || '—',
    remaining: `${formatDecimal(spool.remainingQuantity, 1)} ${spool.unit}`,
    location: spool.storageLocation ?? '—',
    mounted: spool.mounted ? 'Mounted' : 'Available',
    lifecycle: spool.lifecycle,
  }));
  const headers = [
    { key: 'displayId', header: 'Spool' }, { key: 'material', header: 'Material' },
    { key: 'product', header: 'Product' }, { key: 'remaining', header: 'Remaining' },
    { key: 'location', header: 'Location' }, { key: 'mounted', header: 'Assignment' },
    { key: 'lifecycle', header: 'Lifecycle' },
  ];

  return <PageShell
    title="Filament spools"
    description={`${query.data.total} physical spools; quantities are attributed from the material inventory ledger.`}
    breadcrumbs={[{ label: 'Machines', to: '/machine-logbook' }, { label: 'Inventory', to: '/machine-logbook/inventory' }, { label: 'Filament spools' }]}
    actions={hasPermission(currentUser, PermissionId.filament_spoolsmanage) ? <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>Register spool</Button> : undefined}
    width="wide"
    className="machine-logbook-page table-page"
  >
    <div className="filter-bar">
      <Search labelText="Search spools" value={params.get('search') || ''} onChange={(event) => update('search', event.currentTarget.value)} />
      <Select id="spool-lifecycle" labelText="Lifecycle" hideLabel value={params.get('lifecycle') || ''} onChange={(event) => update('lifecycle', event.target.value)}>
        <SelectItem value="" text="All lifecycle states" /><SelectItem value="active" text="Active" /><SelectItem value="retired" text="Retired" />
      </Select>
    </div>
    <DataTable rows={rows} headers={headers}>{({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer>
      <Table {...getTableProps()} aria-label="Filament spools"><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
        <TableBody>{tableRows.map((row) => { const raw = rows.find((item) => item.id === row.id)!; return <TableRow {...getRowProps({ row })} key={row.id} className="clickable-row" onClick={() => navigate(`/machine-logbook/spools/${row.id}`)}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'lifecycle' ? lifecycleTag(raw.lifecycle) : cell.value as string}</TableCell>)}</TableRow>; })}</TableBody>
      </Table>
    </TableContainer>}</DataTable>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10, 25, 50, 100]} totalItems={query.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => { const next = new URLSearchParams(params); next.set('page', String(nextPage)); next.set('pageSize', String(nextSize)); setParams(next); }} />
    <Modal open={createOpen} modalHeading="Register filament spool" primaryButtonText={mutation.isPending ? 'Registering…' : 'Register spool'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || materials.isPending} onRequestClose={() => setCreateOpen(false)} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        <Select id="spool-material" labelText="Filament material" {...form.register('materialId', { required: true })}><SelectItem value="" text="Select a material" />{materials.data?.items.filter((item) => item.active && item.unit === 'g').map((item) => <SelectItem key={item.id} value={item.id} text={`${item.name} · ${formatDecimal(item.unassignedQuantity ?? item.quantity, 1)} g unassigned`} />)}</Select>
        <Select id="spool-stock-mode" labelText="Stock source" {...form.register('stockMode')}><SelectItem value="existing_stock" text="Allocate existing stock" /><SelectItem value="new_acquisition" text="New purchase" /></Select>
        <TextInput id="spool-net-weight" labelText="Initial net weight (g)" {...form.register('initialNetWeightG', { required: true })} />
        {form.watch('stockMode') === 'new_acquisition' && <TextInput id="spool-total-price" labelText="Total purchase price (€)" {...form.register('totalPrice', { required: true })} />}
        <div className="form-grid"><TextInput id="spool-manufacturer" labelText="Manufacturer" {...form.register('manufacturer')} /><TextInput id="spool-product" labelText="Product" {...form.register('productName')} /></div>
        <div className="form-grid"><TextInput id="spool-tare" labelText="Tare weight (g)" {...form.register('tareWeightG')} /><TextInput id="spool-location" labelText="Storage location" {...form.register('storageLocation')} /></div>
        <TextInput id="spool-reference" labelText="Acquisition reference" {...form.register('acquisitionReference')} />
        <TextInput id="spool-notes" labelText="Notes" {...form.register('notes')} />
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Spool not registered" subtitle="Check the material balance and reload if inventory changed." />}
      </Stack>
    </Modal>
  </PageShell>;
}
