import './styles.scss';
import { Edit, InventoryManagement } from '@carbon/icons-react';
import {
  Button, InlineNotification, Modal, Pagination, Select, SelectItem, Stack, StructuredListBody,
  StructuredListCell, StructuredListRow, StructuredListWrapper, Tag, TextInput, Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import {
  addFilamentSpoolIdentifier, consumeFilamentSpool, correctFilamentSpoolStock, updateFilamentSpool,
} from '../../api/generated/filament-spools/filament-spools';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatDateTime, formatDecimal } from './formatting';
import { machineLogbookKeys, materialQuery, spoolQuery, spoolTransactionsQuery } from './queries';

type Dialog = 'consume' | 'correct' | 'edit' | 'identifier' | null;
type Fields = { quantity: string; physicalQuantity: string; acquisitionUnitCost: string; note: string; manufacturer: string; productName: string; tareWeightG: string; storageLocation: string; lifecycle: 'active' | 'archived'; identifierKind: 'nfc' | 'barcode' | 'qr'; identifierValue: string };

export function FilamentSpoolDetailPage() {
  const { spoolId = '' } = useParams();
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [page, setPage] = useState(1);
  const spool = useQuery(spoolQuery(spoolId));
  const material = useQuery({ ...materialQuery(spool.data?.materialId ?? ''), enabled: Boolean(spool.data?.materialId) });
  const transactions = useQuery(spoolTransactionsQuery(spoolId, page));
  const form = useForm<Fields>({ defaultValues: { lifecycle: 'active', identifierKind: 'barcode' } });
  const refresh = async () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const mutation = useMutation({
    mutationFn: async (values: Fields) => {
      const current = spool.data!;
      const inventoryVersion = material.data!.inventoryVersion;
      if (dialog === 'consume') return consumeFilamentSpool(spoolId, { quantity: values.quantity, disposal: false, reason: null, note: values.note || null, occurredAt: new Date().toISOString(), expectedInventoryVersion: inventoryVersion, expectedSpoolVersion: current.version });
      if (dialog === 'correct') return correctFilamentSpoolStock(spoolId, { physicalQuantity: values.physicalQuantity, reason: 'inventory_count', acquisitionUnitCost: values.acquisitionUnitCost || null, note: values.note || null, occurredAt: new Date().toISOString(), expectedInventoryVersion: inventoryVersion, expectedSpoolVersion: current.version });
      if (dialog === 'identifier') return addFilamentSpoolIdentifier(spoolId, { kind: values.identifierKind, value: values.identifierValue });
      return updateFilamentSpool(spoolId, { manufacturer: values.manufacturer || null, productName: values.productName || null, tareWeightG: values.tareWeightG || null, acquiredOn: current.acquiredOn ?? null, acquisitionReference: current.acquisitionReference ?? null, storageLocation: values.storageLocation || null, notes: values.note || null, lifecycle: values.lifecycle, expectedVersion: current.version });
    },
    onSuccess: async () => { setDialog(null); await refresh(); },
  });
  const openEdit = () => { const item = spool.data!; form.reset({ manufacturer: item.manufacturer ?? '', productName: item.productName ?? '', tareWeightG: item.tareWeightG ?? '', storageLocation: item.storageLocation ?? '', note: item.notes ?? '', lifecycle: item.lifecycle, identifierKind: 'barcode', identifierValue: '', quantity: '', physicalQuantity: '', acquisitionUnitCost: '' }); setDialog('edit'); };

  if (spool.isPending || transactions.isPending) return <FullPageLoading label="Loading filament spool" />;
  if (spool.isError || transactions.isError) return <ErrorState message="This spool could not be loaded." onRetry={() => { spool.refetch(); transactions.refetch(); }} />;
  const item = spool.data;
  const canManage = hasPermission(currentUser, PermissionId.filament_spoolsmanage);
  return <PageShell
    title={item.displayId}
    description={`${item.materialName} · ${formatDecimal(item.remainingQuantity, 1)} ${item.unit} remaining`}
    breadcrumbs={[{ label: 'Workshop', to: '/machine-logbook' }, { label: 'Filament spools', to: '/machine-logbook/spools' }, { label: item.displayId }]}
    actions={canManage ? <><Button kind="secondary" renderIcon={Edit} onClick={openEdit}>Edit</Button><Button renderIcon={InventoryManagement} onClick={() => setDialog('consume')}>Record consumption</Button></> : undefined}
    width="wide"
    className="machine-logbook-page detail-page"
  >
    <div className="detail-grid">
      <Tile><h2>Spool</h2><StructuredListWrapper><StructuredListBody>
        {[['Material', item.materialName], ['Manufacturer', item.manufacturer ?? '—'], ['Product', item.productName ?? '—'], ['Initial net weight', `${item.initialNetWeightG} g`], ['Remaining', `${item.remainingQuantity} ${item.unit}`], ['Tare', item.tareWeightG ? `${item.tareWeightG} g` : '—'], ['Storage', item.storageLocation ?? '—']].map(([label, value]) => <StructuredListRow key={label}><StructuredListCell>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>)}
      </StructuredListBody></StructuredListWrapper><Tag type={item.lifecycle === 'active' ? 'green' : 'gray'}>{item.lifecycle}</Tag>{item.mounted && <Tag type="blue">Mounted</Tag>}</Tile>
      <Tile><div className="section-heading"><h2>Identifiers</h2>{canManage && <Button kind="ghost" size="sm" onClick={() => setDialog('identifier')}>Add identifier</Button>}</div>{item.identifiers.length === 0 ? <p className="section-description">No scannable identifiers.</p> : <ul className="summary-list">{item.identifiers.map((identifier) => <li key={identifier.id}><span><strong>{identifier.kind}</strong><small>{identifier.value}</small></span></li>)}</ul>}</Tile>
      <Tile><div className="section-heading"><h2>Inventory history</h2>{canManage && <Button kind="ghost" size="sm" onClick={() => setDialog('correct')}>Correct stock</Button>}</div>{transactions.data.items.length === 0 ? <p className="section-description">No transactions.</p> : <ul className="summary-list">{transactions.data.items.map((transaction) => <li key={transaction.id}><span><strong>{transaction.kind}</strong><small>{formatDateTime(transaction.occurredAt)}</small></span><span>{transaction.quantityDelta} {item.unit}</span></li>)}</ul>}<Pagination page={page} pageSize={25} pageSizes={[25]} totalItems={transactions.data.total} onChange={({ page: next }) => setPage(next)} /></Tile>
      <Tile><h2>Notes</h2><p>{item.notes || '—'}</p></Tile>
    </div>
    <Modal open={dialog !== null} modalHeading={dialog === 'consume' ? 'Record spool consumption' : dialog === 'correct' ? 'Correct spool stock' : dialog === 'identifier' ? 'Add spool identifier' : 'Edit spool'} primaryButtonText={mutation.isPending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || material.isPending} onRequestClose={() => setDialog(null)} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        {dialog === 'consume' && <TextInput id="spool-consume" labelText="Quantity (g)" {...form.register('quantity', { required: true })} />}
        {dialog === 'correct' && <><TextInput id="spool-physical" labelText="Physical quantity (g)" {...form.register('physicalQuantity', { required: true })} /><TextInput id="spool-unit-cost" labelText="Acquisition cost per g (only needed when adding stock without an average)" {...form.register('acquisitionUnitCost')} /></>}
        {dialog === 'identifier' && <><Select id="identifier-kind" labelText="Identifier kind" {...form.register('identifierKind')}><SelectItem value="barcode" text="Barcode" /><SelectItem value="qr" text="QR code" /><SelectItem value="nfc" text="NFC" /></Select><TextInput id="identifier-value" labelText="Value" {...form.register('identifierValue', { required: true })} /></>}
        {dialog === 'edit' && <><div className="form-grid"><TextInput id="edit-manufacturer" labelText="Manufacturer" {...form.register('manufacturer')} /><TextInput id="edit-product" labelText="Product" {...form.register('productName')} /></div><div className="form-grid"><TextInput id="edit-tare" labelText="Tare weight (g)" {...form.register('tareWeightG')} /><TextInput id="edit-location" labelText="Storage location" {...form.register('storageLocation')} /></div><Select id="edit-lifecycle" labelText="Lifecycle" {...form.register('lifecycle')}><SelectItem value="active" text="Active" /><SelectItem value="archived" text="Archived" /></Select></>}
        {dialog !== 'identifier' && <TextInput id="spool-dialog-note" labelText={dialog === 'edit' ? 'Notes' : 'Transaction note'} {...form.register('note')} />}
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Spool was not updated" subtitle="Reload the spool and material balance, then retry." />}
      </Stack>
    </Modal>
  </PageShell>;
}
