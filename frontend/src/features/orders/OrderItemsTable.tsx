import type { ReactNode } from 'react';
import {
  Button,
  IconButton,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Edit, Renew, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { Order, OrderItem } from '../../api/generated/models';
import { AttentionFlag, attentionColumnClassName } from '../../app/components/AttentionFlag';
import { formatDateTimeRange } from '../../app/dateTime';
import { RefLink } from '../../app/RefLink';
import { formatDuration, formatQuantity } from '../machinelogbook/shared/format';
import { machineLogbookPaths } from '../machinelogbook/shared/paths';
import { formatMoney } from './formatting';
import { activeItems } from './logic';
import { TableCard } from './TableCard';

type Props = {
  order: Order;
  editable: boolean;
  busy: boolean;
  canReadInventory?: boolean;
  /** The "Add" button of a draft. */
  action?: ReactNode;
  onRefresh: (item: OrderItem) => void;
  onRemove: (item: OrderItem) => void;
  onEdit: (item: OrderItem) => void;
};

const kindTag: Record<OrderItem['kind'], { label: string; type: 'teal' | 'gray' | 'outline' }> = {
  machine_job: { label: 'Job', type: 'teal' },
  inventory_item: { label: 'Stock', type: 'gray' },
  manual: { label: 'Custom', type: 'outline' },
};

function ItemName({ item, canReadInventory }: { item: OrderItem; canReadInventory: boolean }) {
  if (item.sourceMachineJobId && item.snapshot)
    return (
      <RefLink reference={item.snapshot.displayId} id={item.sourceMachineJobId} kind="job">
        {item.description}
      </RefLink>
    );
  if (item.kind === 'inventory_item' && item.sourceMaterialId && canReadInventory)
    return (
      <CarbonLink as={Link} to={machineLogbookPaths.material(item.sourceMaterialId)}>
        {item.description}
      </CarbonLink>
    );
  return <span>{item.description}</span>;
}

function ItemDetail({ item }: { item: OrderItem }) {
  const snapshot = item.snapshot;
  if (!snapshot) return <>{item.kind === 'inventory_item' ? 'From inventory' : 'Custom line'}</>;
  const usage =
    snapshot.usages
      .map((entry) => `${formatQuantity(entry.quantity)} ${entry.unit} ${entry.materialName}`)
      .join(', ') || 'No material';
  return (
    <>
      {snapshot.displayId} · {snapshot.machineName} · {formatDateTimeRange(snapshot.startsAt, snapshot.endsAt)} (
      {formatDuration(Math.round(Number(snapshot.durationNanoseconds) / 1e9))}) · {usage}
      {snapshot.pricing ? ` · ${snapshot.pricing.pricingGroupName} prices` : ''}
    </>
  );
}

/** The items of an order: jobs with their frozen charge details, stock and custom lines. */
export function OrderItemsTable({
  order,
  editable,
  busy,
  canReadInventory = false,
  action,
  onRefresh,
  onRemove,
  onEdit,
}: Props) {
  const items = activeItems(order);
  const draft = order.status === 'draft';
  return (
    <TableCard title="Items" count={items.length} action={action}>
      <Table aria-label="Order items" size="lg">
        <TableHead>
          <TableRow>
            <TableHeader>Item</TableHeader>
            <TableHeader className="sales-hide-narrow">Kind</TableHeader>
            <TableHeader className="sales-num">Quantity</TableHeader>
            <TableHeader className="sales-num sales-hide-narrow">Unit price</TableHeader>
            <TableHeader className="sales-num">Amount</TableHeader>
            {editable ? (
              <TableHeader className="sales-row-actions">
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            ) : (
              <TableHeader className={attentionColumnClassName}>
                <span className="cds--visually-hidden">Needs attention</span>
              </TableHeader>
            )}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="sales-empty-cell">
                No items yet.{draft ? ' Add a job, something from inventory or a custom line.' : ''}
              </TableCell>
            </TableRow>
          )}
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="sales-cell">
                  <ItemName item={item} canReadInventory={canReadInventory} />
                  <span className="sales-secondary">
                    <ItemDetail item={item} />
                  </span>
                  {(item.sourceChanged || item.snapshot?.overrideReason) && (
                    <span className="sales-inline">
                      {item.sourceChanged && (
                        <Tag type="red" size="sm">
                          Job changed since charged
                        </Tag>
                      )}
                      {item.snapshot?.overrideReason && (
                        <Tag type="outline" size="sm" title={item.snapshot.overrideReason}>
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
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="sales-hide-narrow">
                <Tag type={kindTag[item.kind].type} size="sm">
                  {kindTag[item.kind].label}
                </Tag>
              </TableCell>
              <TableCell className="sales-num">
                {item.kind === 'machine_job' ? '1 job' : `${formatQuantity(item.quantity, 6)} ${item.unit}`}
              </TableCell>
              <TableCell className="sales-num sales-hide-narrow">{formatMoney(item.unitPrice)}</TableCell>
              <TableCell className="sales-num">{formatMoney(item.amount)}</TableCell>
              {editable ? (
                <TableCell className="sales-row-actions">
                  {(item.kind === 'manual' || item.kind === 'inventory_item') && (
                    <IconButton label={`Edit ${item.description}`} kind="ghost" size="sm" onClick={() => onEdit(item)}>
                      <Edit />
                    </IconButton>
                  )}
                  <IconButton
                    label={`Remove ${item.description}`}
                    kind="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRemove(item)}
                  >
                    <TrashCan />
                  </IconButton>
                </TableCell>
              ) : (
                <TableCell className={attentionColumnClassName}>
                  <AttentionFlag
                    attention={
                      item.sourceChanged
                        ? [
                            {
                              code: 'source_changed',
                              message: 'The job changed after it was charged; the charge keeps the original price.',
                            },
                          ]
                        : []
                    }
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}
