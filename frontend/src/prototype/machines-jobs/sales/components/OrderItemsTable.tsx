import { useState } from 'react';
import { Button, IconButton, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextInput } from '@carbon/react';
import { Checkmark, Close, Edit, Renew, TrashCan } from '@carbon/icons-react';
import { formatDateTimeRange } from '../../../../app/dateTime';
import { RefLink } from '../../components/RefLink';
import { formatDuration } from '../../derived';
import type { Job } from '../../types';
import { formatEur, formatQuantity, moneyText, parseMoney, parseQuantity } from '../format';
import { activeItems, itemChanged, sum, type OrderView } from '../logic';
import type { ManualItemInput } from '../engine';
import type { OrderItem } from '../types';

type Props = {
  order: OrderView; jobs: Job[]; editable: boolean; busy: boolean;
  onRefresh: (item: OrderItem) => void; onRemove: (item: OrderItem) => void; onSave: (item: OrderItem, input: ManualItemInput) => void;
};

function EditCells({ item, busy, onSave, onCancel }: { item: OrderItem; busy: boolean; onSave: (input: ManualItemInput) => void; onCancel: () => void }) {
  const [description, setDescription] = useState(item.description);
  const [quantity, setQuantity] = useState(formatQuantity(item.quantity));
  const [unitPrice, setUnitPrice] = useState(moneyText(item.unitPrice));
  const parsedQuantity = parseQuantity(quantity.replace(/\./g, ''));
  const parsedPrice = parseMoney(unitPrice);
  const valid = description.trim() !== '' && parsedQuantity !== null && parsedQuantity > 0 && parsedPrice !== null;
  return (
    <TableRow>
      <TableCell><TextInput id={`edit-desc-${item.id}`} labelText="Description" hideLabel size="sm" value={description} onChange={(event) => setDescription(event.target.value)} invalid={description.trim() === ''} invalidText="Describe the item" /></TableCell>
      <TableCell><TextInput id={`edit-qty-${item.id}`} labelText="Quantity" hideLabel size="sm" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} invalid={parsedQuantity === null || parsedQuantity <= 0} invalidText="Greater than zero" /></TableCell>
      <TableCell><TextInput id={`edit-price-${item.id}`} labelText="Unit price" hideLabel size="sm" inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} invalid={parsedPrice === null} invalidText="e.g. 4,50" /></TableCell>
      <TableCell className="sales-num">{valid ? formatEur(Math.round((parsedQuantity ?? 0) * (parsedPrice ?? 0) * 100) / 100) : '—'}</TableCell>
      <TableCell className="sales-row-actions">
        <IconButton label="Save item" kind="ghost" size="sm" disabled={!valid || busy} onClick={() => onSave({ description, quantity: parsedQuantity!, unit: item.unit, unitPrice: parsedPrice! })}><Checkmark /></IconButton>
        <IconButton label="Discard changes" kind="ghost" size="sm" onClick={onCancel}><Close /></IconButton>
      </TableCell>
    </TableRow>
  );
}

export function OrderItemsTable({ order, jobs, editable, busy, onRefresh, onRemove, onSave }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const items = activeItems(order);
  const hasHistory = order.items.some((item) => item.removedAt !== null);
  return (
    <TableContainer title="Items" description={order.status === 'draft' ? 'Prices freeze when the order is finalized.' : 'Prices were frozen when the order was finalized.'}>
      <Table aria-label="Order items">
        <TableHead>
          <TableRow>
            <TableHeader>Item</TableHeader><TableHeader>Quantity</TableHeader><TableHeader>Unit price</TableHeader><TableHeader className="sales-num">Amount</TableHeader>
            <TableHeader>{editable ? <span className="cds--visually-hidden">Actions</span> : null}</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {items.length === 0 && <TableRow><TableCell colSpan={5}>No items yet. Use “Add items” to add jobs, catalog items or a custom item.</TableCell></TableRow>}
          {items.map((item) => {
            if (editing === item.id) return <EditCells key={item.id} item={item} busy={busy} onCancel={() => setEditing(null)} onSave={(input) => { onSave(item, input); setEditing(null); }} />;
            const job = item.sourceJobId ? jobs.find((candidate) => candidate.id === item.sourceJobId) : undefined;
            const snapshot = item.snapshot;
            const changed = itemChanged(item, jobs);
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="mj-title-with-thumb">
                    
                    <div className="mj-cell-stack">
                      {job ? <RefLink reference={job.displayId} id={job.id}>{item.description}</RefLink> : <span>{item.description}</span>}
                      {snapshot ? (
                        <>
                          <span className="mj-secondary">{job ? snapshot.displayId : <RefLink reference={snapshot.displayId} />} · {snapshot.machineName} · {formatDateTimeRange(snapshot.startsAt, snapshot.endsAt)} ({formatDuration(snapshot.durationSeconds)})</span>
                          <span className="mj-secondary">{snapshot.usages.map((usage) => `${formatQuantity(usage.quantity)} ${usage.unit} ${usage.materialName}`).join(', ') || 'No material'} · {snapshot.pricingGroupName} prices ({snapshot.pricingVia})</span>
                        </>
                      ) : <span className="mj-secondary">Manual item</span>}
                      <span className="mj-inline">
                        {changed && <Tag type="red" size="sm">Job changed since charged</Tag>}
                        {snapshot?.overrideReason && <Tag type="outline" size="sm" title={snapshot.overrideReason}>Price adjusted</Tag>}
                        {changed && editable && <Button kind="ghost" size="sm" renderIcon={Renew} disabled={busy} onClick={() => onRefresh(item)}>Refresh from job</Button>}
                        {changed && !editable && <span className="mj-secondary">The charge keeps the price from when it was added.</span>}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{item.kind === 'machine_job' ? '1 job' : `${formatQuantity(item.quantity)} ${item.unit}`}</TableCell>
                <TableCell>{formatEur(item.unitPrice)}</TableCell>
                <TableCell className="sales-num">{formatEur(item.amount)}</TableCell>
                <TableCell className="sales-row-actions">
                  {editable && item.kind === 'manual' && <IconButton label="Edit item" kind="ghost" size="sm" onClick={() => setEditing(item.id)}><Edit /></IconButton>}
                  {editable && <IconButton label="Remove item" kind="ghost" size="sm" disabled={busy} onClick={() => onRemove(item)}><TrashCan /></IconButton>}
                </TableCell>
              </TableRow>
            );
          })}
          {items.length > 0 && (
            <TableRow>
              <TableCell colSpan={3}><strong>Total</strong></TableCell>
              <TableCell className="sales-num"><strong>{formatEur(sum(items.map((item) => item.amount)))}</strong></TableCell>
              <TableCell />
            </TableRow>
          )}
        </TableBody>
      </Table>
      {hasHistory && <p className="mj-secondary sales-table-note">Earlier versions of changed or removed items stay in the timeline.</p>}
    </TableContainer>
  );
}
