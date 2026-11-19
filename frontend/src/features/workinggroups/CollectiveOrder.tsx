import { useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  InlineNotification,
  Link,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { WorkingGroupBudgetPeriod, WorkingGroupPurchase } from '../../api/generated/models';
import {
  arrivedWorkingGroupPurchaseOrder,
  createWorkingGroupPurchaseOrder,
  getDownloadWorkingGroupPurchaseOrderInvoiceUrl,
  uploadWorkingGroupPurchaseOrderInvoice,
} from '../../api/generated/working-groups/working-groups';
import { formatDate } from '../../app/dateTime';
import { useNotify } from '../../app/toasts';
import { formatCents, toCents } from '../orders/money';
import { ACCEPTED_FILES, MAX_FILE_BYTES, amountCents, fileHeaders } from './financeModel';
import { financeRulesOptions, purchaseOrdersOptions } from './financeQueries';
import { plural } from './taskModel';
import { useWgMutation } from './useWgMutation';

/** Finance managers: pick approved central purchases of the period, mark them as ordered, follow the orders placed. */
export function CollectiveOrder({
  purchases,
  period,
}: {
  purchases: readonly WorkingGroupPurchase[];
  period: WorkingGroupBudgetPeriod | undefined;
}) {
  const notify = useNotify();
  const orders = useQuery(purchaseOrdersOptions);
  const rules = useQuery(financeRulesOptions);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [shop, setShop] = useState('');
  const [projectId, setProjectId] = useState('');
  const [touched, setTouched] = useState(false);

  const waiting = purchases.filter(
    (purchase) =>
      purchase.how === 'central' &&
      purchase.status === 'approved' &&
      !purchase.orderId &&
      purchase.periodId === period?.id,
  );
  const chosen = waiting.filter((purchase) => picked.has(purchase.id));
  const total = chosen.reduce((sum, purchase) => sum + amountCents(purchase), 0);
  const threshold = rules.data ? toCents(rules.data.projectThreshold) : null;
  const needsProject = threshold !== null && threshold > 0 && total >= threshold;
  const toggle = (id: string, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const place = useWgMutation(() =>
    createWorkingGroupPurchaseOrder({
      shop: shop.trim(),
      purchaseIds: chosen.map((purchase) => purchase.id),
      projectRequestId: needsProject ? projectId : undefined,
    }),
  );
  const shopError = touched && shop.trim() === '' ? 'Enter the shop.' : undefined;
  const projectError = touched && needsProject && projectId === '' ? 'Choose the project request.' : undefined;
  const submit = () => {
    setTouched(true);
    if (chosen.length === 0 || shop.trim() === '' || (needsProject && projectId === '')) return;
    place.mutate(undefined, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Marked as ordered' });
        setPicked(new Set());
        setShop('');
        setProjectId('');
        setTouched(false);
      },
    });
  };

  const arrived = useWgMutation((order: { id: string; version: number }) =>
    arrivedWorkingGroupPurchaseOrder(order.id, { expectedVersion: order.version }),
  );
  const invoiceTarget = useRef<string | null>(null);
  const invoiceInput = useRef<HTMLInputElement>(null);
  const invoice = useWgMutation((args: { id: string; file: File }) =>
    uploadWorkingGroupPurchaseOrderInvoice(args.id, args.file, { headers: fileHeaders(args.file) }),
  );

  return (
    <div className="wg-collective">
      <div className="wg-collective__top">
        <section className="wg-card-list" aria-label="Approved purchases to order">
          <Table size="md" aria-label="Approved purchases to order">
            <TableHead>
              <TableRow>
                <TableHeader>
                  <span className="wg-visually-hidden">Select</span>
                </TableHeader>
                <TableHeader>Item</TableHeader>
                <TableHeader>Group</TableHeader>
                <TableHeader>Amount</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {waiting.map((purchase) => (
                <TableRow key={purchase.id}>
                  <TableCell>
                    <Checkbox
                      id={`wg-pick-${purchase.id}`}
                      labelText={`Select ${purchase.item}`}
                      hideLabel
                      checked={picked.has(purchase.id)}
                      onChange={(_, { checked }) => toggle(purchase.id, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    {purchase.quantity} × {purchase.item}
                  </TableCell>
                  <TableCell>{purchase.groupName}</TableCell>
                  <TableCell>{formatCents(amountCents(purchase))}</TableCell>
                </TableRow>
              ))}
              {waiting.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>Nothing waits for an order in this period.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </section>

        <section className="wg-sbar wg-order-card" aria-label="This order">
          <h3 className="wg-subhead">This order</h3>
          <div className="wg-minetile__row">
            <span>Items</span>
            <span>{chosen.length}</span>
          </div>
          <div className="wg-minetile__row">
            <span>Invoice total</span>
            <span>{formatCents(total)}</span>
          </div>
          <TextInput
            id="wg-order-shop"
            labelText="Shop"
            value={shop}
            invalid={Boolean(shopError)}
            invalidText={shopError}
            onChange={(event) => setShop(event.target.value)}
          />
          {needsProject && (
            <Select
              id="wg-order-project"
              labelText="Project request"
              value={projectId}
              invalid={Boolean(projectError)}
              invalidText={projectError}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <SelectItem value="" text="Choose one" />
              {(rules.data?.projectRequests ?? []).map((request) => (
                <SelectItem key={request.id} value={request.id} text={`${request.number} ${request.label}`} />
              ))}
            </Select>
          )}
          {place.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not ordered"
              subtitle="Reload and check the items."
            />
          )}
          <Button kind="primary" size="md" disabled={chosen.length === 0 || place.isPending} onClick={submit}>
            Mark as ordered
          </Button>
        </section>
      </div>

      <section className="wg-card-list" aria-labelledby="wg-orders-h">
        <h3 id="wg-orders-h" className="wg-subhead wg-subhead--pad">
          Orders placed
        </h3>
        <input
          ref={invoiceInput}
          type="file"
          className="wg-visually-hidden"
          tabIndex={-1}
          accept={ACCEPTED_FILES}
          aria-label="Invoice file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || !invoiceTarget.current) return;
            if (file.size > MAX_FILE_BYTES) {
              notify({ kind: 'error', title: 'The file is larger than 10 MiB' });
              return;
            }
            invoice.mutate({ id: invoiceTarget.current, file });
          }}
        />
        {(invoice.isError || arrived.isError) && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle="Try again." />
        )}
        <Table size="md" aria-label="Orders placed">
          <TableHead>
            <TableRow>
              <TableHeader>Date</TableHeader>
              <TableHeader>Shop</TableHeader>
              <TableHeader>Items</TableHeader>
              <TableHeader>Groups</TableHeader>
              <TableHeader>Project request</TableHeader>
              <TableHeader>Invoice total</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>
                <span className="wg-visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {(orders.data?.items ?? []).map((order) => {
              const members = purchases.filter((purchase) => purchase.orderId === order.id);
              const groups = [...new Set(members.map((purchase) => purchase.groupName))].join(', ');
              return (
                <TableRow key={order.id}>
                  <TableCell>{formatDate(order.createdAt)}</TableCell>
                  <TableCell>{order.shop}</TableCell>
                  <TableCell>{plural(order.purchaseIds.length, 'item')}</TableCell>
                  <TableCell>{groups || '–'}</TableCell>
                  <TableCell>{order.projectNumber ?? '–'}</TableCell>
                  <TableCell>{formatCents(toCents(order.totalAmount))}</TableCell>
                  <TableCell>
                    <Tag size="sm" type={order.status === 'arrived' ? 'green' : 'purple'}>
                      {order.status === 'arrived' ? 'Arrived' : 'Ordered'}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    <div className="wg-order-actions">
                      {order.hasInvoice ? (
                        <Link
                          href={getDownloadWorkingGroupPurchaseOrderInvoiceUrl(order.id)}
                          target="_blank"
                          rel="noopener"
                        >
                          Invoice
                        </Link>
                      ) : (
                        <Button
                          kind="ghost"
                          size="sm"
                          onClick={() => {
                            invoiceTarget.current = order.id;
                            invoiceInput.current?.click();
                          }}
                        >
                          Upload invoice
                        </Button>
                      )}
                      {order.status === 'ordered' && (
                        <Button
                          kind="tertiary"
                          size="sm"
                          disabled={arrived.isPending}
                          onClick={() => arrived.mutate({ id: order.id, version: order.version })}
                        >
                          It arrived
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {orders.data && orders.data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>No orders yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
