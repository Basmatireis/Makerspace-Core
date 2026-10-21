import {
  Button,
  IconButton,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Edit, Renew, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { Order, OrderItem } from '../../api/generated/models';
import { formatDateTimeRange } from '../../app/dateTime';
import { RefLink } from '../../app/RefLink';
import { formatDuration, formatQuantity } from '../machinelogbook/shared/format';
import { formatMoney } from './formatting';
import { activeItems } from './logic';
import { formatCents, sumCents } from './money';

type Props = {
  order: Order;
  editable: boolean;
  busy: boolean;
  canReadInventory?: boolean;
  onRefresh: (item: OrderItem) => void;
  onRemove: (item: OrderItem) => void;
  onEdit: (item: OrderItem) => void;
};

/** The items of an order: jobs with their frozen charge details, manual items, and the total. */
export function OrderItemsTable({
  order,
  editable,
  busy,
  canReadInventory = false,
  onRefresh,
  onRemove,
  onEdit,
}: Props) {
  const items = activeItems(order);
  const draft = order.status === 'draft';
  return (
    <TableContainer
      title="Items"
      description={
        draft ? 'Prices freeze when the order is finalized.' : 'Prices were frozen when the order was finalized.'
      }
    >
      <Table aria-label="Order items">
        <TableHead>
          <TableRow>
            <TableHeader>Item</TableHeader>
            <TableHeader>Quantity</TableHeader>
            <TableHeader>Unit price</TableHeader>
            <TableHeader className="sales-num">Amount</TableHeader>
            <TableHeader>{editable ? <span className="cds--visually-hidden">Actions</span> : null}</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>No items yet. Use “Add items” to add jobs, stock or a custom item.</TableCell>
            </TableRow>
          )}
          {items.map((item) => {
            const snapshot = item.snapshot;
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="mj-cell-stack">
                    {item.sourceMachineJobId && snapshot ? (
                      <RefLink reference={snapshot.displayId} id={item.sourceMachineJobId} kind="job">
                        {item.description}
                      </RefLink>
                    ) : item.kind === 'inventory_item' && item.sourceMaterialId && canReadInventory ? (
                      <CarbonLink as={Link} to={`/machine-logbook/inventory/materials/${item.sourceMaterialId}`}>
                        {item.description}
                      </CarbonLink>
                    ) : (
                      <span>{item.description}</span>
                    )}
                    {snapshot ? (
                      <>
                        <span className="mj-secondary">
                          {snapshot.displayId} · {snapshot.machineName} ·{' '}
                          {formatDateTimeRange(snapshot.startsAt, snapshot.endsAt)} (
                          {formatDuration(Math.round(Number(snapshot.durationNanoseconds) / 1e9))})
                        </span>
                        <span className="mj-secondary">
                          {snapshot.usages
                            .map((usage) => `${formatQuantity(usage.quantity)} ${usage.unit} ${usage.materialName}`)
                            .join(', ') || 'No material'}
                          {snapshot.pricing ? ` · ${snapshot.pricing.pricingGroupName} prices` : ''}
                        </span>
                      </>
                    ) : (
                      <span className="mj-secondary">
                        {item.kind === 'inventory_item' ? 'From stock' : 'Manual item'}
                      </span>
                    )}
                    <span className="mj-inline">
                      {item.kind === 'inventory_item' && (
                        <Tag type="outline" size="sm">
                          Stock
                        </Tag>
                      )}
                      {item.sourceChanged && (
                        <Tag type="red" size="sm">
                          Job changed since charged
                        </Tag>
                      )}
                      {snapshot?.overrideReason && (
                        <Tag type="outline" size="sm" title={snapshot.overrideReason}>
                          Price adjusted
                        </Tag>
                      )}
                      {item.sourceChanged && editable && (
                        <Button
                          kind="ghost"
                          size="sm"
                          renderIcon={Renew}
                          disabled={busy}
                          onClick={() => onRefresh(item)}
                        >
                          Refresh from job
                        </Button>
                      )}
                      {item.sourceChanged && !editable && (
                        <span className="mj-secondary">The charge keeps the price from when it was added.</span>
                      )}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {item.kind === 'machine_job' ? '1 job' : `${formatQuantity(item.quantity, 6)} ${item.unit}`}
                </TableCell>
                <TableCell>{formatMoney(item.unitPrice)}</TableCell>
                <TableCell className="sales-num">{formatMoney(item.amount)}</TableCell>
                <TableCell className="sales-row-actions">
                  {editable && (item.kind === 'manual' || item.kind === 'inventory_item') && (
                    <IconButton label={`Edit ${item.description}`} kind="ghost" size="sm" onClick={() => onEdit(item)}>
                      <Edit />
                    </IconButton>
                  )}
                  {editable && (
                    <IconButton
                      label={`Remove ${item.description}`}
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRemove(item)}
                    >
                      <TrashCan />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {items.length > 0 && (
            <TableRow>
              <TableCell colSpan={3}>
                <strong>Total</strong>
              </TableCell>
              <TableCell className="sales-num">
                <strong>{formatCents(sumCents(items.map((item) => item.amount)))}</strong>
              </TableCell>
              <TableCell />
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
