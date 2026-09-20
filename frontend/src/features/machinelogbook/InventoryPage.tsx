import {
  Button,
  DataTable,
  InlineNotification,
  Modal,
  Pagination,
  Search,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createMaterial } from '../../api/generated/inventory/inventory';
import type { MaterialUnit, StockState } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { StockTag } from './components';
import { formatDecimal, formatMoney } from './formatting';
import { machineLogbookKeys, materialsQuery } from './queries';

const headers = [
  { key: 'name', header: 'Material' },
  { key: 'category', header: 'Category' },
  { key: 'color', header: 'Color' },
  { key: 'quantity', header: 'Current stock' },
  { key: 'average', header: 'Avg. acquisition cost' },
  { key: 'value', header: 'Inventory value' },
  { key: 'recent', header: 'Recent consumption (30d)' },
  { key: 'status', header: 'Status' },
];

type MaterialFields = {
  name: string;
  category: string;
  color: string;
  unit: MaterialUnit;
  lowStockThreshold: string;
};

export function InventoryPage() {
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const form = useForm<MaterialFields>({ defaultValues: { unit: 'g' } });
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 25);
  const query = useQuery(materialsQuery({
    search: params.get('search') || undefined,
    category: params.get('category') || undefined,
    stockState: (params.get('stock') || undefined) as StockState | undefined,
    page,
    pageSize,
  }));
  const mutation = useMutation({
    mutationFn: (values: MaterialFields) => createMaterial({
      name: values.name,
      category: values.category.trim().toLowerCase(),
      color: values.color || null,
      unit: values.unit,
      lowStockThreshold: values.lowStockThreshold || null,
    }),
    onSuccess: async (created) => {
      setCreateOpen(false);
      form.reset({ name: '', category: '', color: '', unit: 'g', lowStockThreshold: '' });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      navigate(`/machine-logbook/inventory/${created.id}`);
    },
  });
  const update = (key: string, value?: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    return next;
  });

  if (query.isPending) return <FullPageLoading label="Loading inventory" />;
  if (query.isError) return <ErrorState message="Inventory could not be loaded." onRetry={() => query.refetch()} />;
  const rows = query.data.items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    color: item.color ?? '—',
    quantity: `${formatDecimal(item.quantity, 3)} ${item.unit}`,
    average: `€ ${formatDecimal(item.averageUnitCost, 4)} / ${item.unit}`,
    value: formatMoney(item.inventoryValue),
    recent: `${formatDecimal(item.recentConsumption, 3)} ${item.unit}`,
    status: item.stockState,
  }));

  return <Stack gap={7} className="machine-logbook-page table-page">
    <PageHeader
      title="Inventory"
      description={`Total inventory value: ${formatMoney(query.data.totalInventoryValue)}`}
      breadcrumbs={[{ label: 'Machine logbook', to: '/machine-logbook' }, { label: 'Inventory' }]}
      actions={hasPermission(currentUser, PermissionId.inventorymanage)
        ? <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>Add material</Button>
        : undefined}
    />
    <div className="filter-bar">
      <Search labelText="Search materials" value={params.get('search') || ''} onChange={(event) => update('search', event.currentTarget.value)} />
      <Select id="stock-filter" labelText="Stock state" hideLabel value={params.get('stock') || ''} onChange={(event) => update('stock', event.target.value)}>
        <SelectItem value="" text="All stock states" />
        <SelectItem value="in_stock" text="In stock" />
        <SelectItem value="low_stock" text="Low stock" />
        <SelectItem value="empty" text="Empty" />
      </Select>
    </div>
    <DataTable rows={rows} headers={headers}>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer>
        <Table {...getTableProps()} tabIndex={0} aria-label="Materials inventory">
          <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
          <TableBody>{tableRows.map((row) => {
            const raw = rows.find((item) => item.id === row.id)!;
            return <TableRow {...getRowProps({ row })} key={row.id} className="clickable-row" onClick={() => navigate(`/machine-logbook/inventory/${row.id}`)}>
              {row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'status' ? <StockTag state={raw.status} /> : cell.value as string}</TableCell>)}
            </TableRow>;
          })}</TableBody>
        </Table>
      </TableContainer>}
    </DataTable>
    <Pagination page={page} pageSize={pageSize} pageSizes={[10, 25, 50, 100]} totalItems={query.data.total} onChange={({ page: nextPage, pageSize: nextSize }) => {
      const next = new URLSearchParams(params);
      next.set('page', String(nextPage));
      next.set('pageSize', String(nextSize));
      setParams(next);
    }} />
    {createOpen && <Modal
      open={createOpen}
      modalHeading="Add material"
      primaryButtonText={mutation.isPending ? 'Adding…' : 'Add material'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      onRequestClose={() => setCreateOpen(false)}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput id="material-name" labelText="Name" {...form.register('name', { required: true })} />
        <TextInput id="material-category" labelText="Normalized category" helperText="For example: pla, petg, plywood" {...form.register('category', { required: true })} />
        <TextInput id="material-color" labelText="Color (optional)" {...form.register('color')} />
        <Select id="material-unit" labelText="Unit" {...form.register('unit')}>
          <SelectItem value="g" text="Grams (g)" />
          <SelectItem value="m" text="Metres (m)" />
          <SelectItem value="ml" text="Millilitres (ml)" />
          <SelectItem value="m2" text="Square metres (m²)" />
          <SelectItem value="piece" text="Pieces" />
        </Select>
        <TextInput id="material-low-stock" labelText="Low-stock threshold (optional)" {...form.register('lowStockThreshold')} />
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Material not created" subtitle="Check the values and make sure the name is unique." />}
      </Stack>
    </Modal>}
  </Stack>;
}
