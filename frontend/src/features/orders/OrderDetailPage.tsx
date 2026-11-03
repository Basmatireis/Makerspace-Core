import { useState } from 'react';
import { Button, Modal, OverflowMenu, OverflowMenuItem, Stack } from '@carbon/react';
import { Add, ArrowRight, Currency, Document as DocumentIcon, Edit, Printer, Renew } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  cancelOrder,
  createReplacementOrder,
  finalizeOrder,
  refreshOrderItem,
  removeOrderItem,
} from '../../api/generated/orders/orders';
import type { Order, OrderItem } from '../../api/generated/models';
import { FactTiles } from '../../app/components/Facts';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { AddItemModal, type AddItemKind } from './AddItemModal';
import { CorrectOrderModal } from './CorrectOrderModal';
import { InventoryItemModal } from './InventoryItemModal';
import { InvoiceSection } from './InvoiceSection';
import { customerKindLabel, methodLabel, requestStateLabel } from './labels';
import { acceptsCashAndCard, activeItems, canPrintReceipt, customerLabel, invoiceRequestBlocker } from './logic';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { BalanceCard, CustomerCard } from './OrderCards';
import { AddJobsModal, CustomItemModal, EditOrderModal } from './OrderDialogs';
import { OrderErrorText } from './OrderErrorText';
import { OrderItemsTable } from './OrderItemsTable';
import { useOrderPaymentRows } from './paymentRows';
import { PaymentsSection } from './PaymentsSection';
import { orderQuery, useFinanceMutation } from './queries';
import { RecordPaymentModal } from './RecordPaymentModal';
import { RequestInvoiceModal } from './RequestInvoiceModal';
import { OrderStatusTag, RequestStateTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

type Dialog =
  | 'edit'
  | 'add'
  | 'jobs'
  | 'stock'
  | 'custom'
  | 'finalize'
  | 'cancel'
  | 'pay'
  | 'checkout'
  | 'correct'
  | 'invoice'
  | null;
const crumbs = [
  { label: 'Sales & payments', to: '/sales' },
  { label: 'Orders', to: '/orders' },
];

export function OrderDetailPage() {
  const { orderId = '' } = useParams();
  const query = useQuery(orderQuery(orderId));
  if (query.isPending) return <FullPageLoading label="Loading order" />;
  if (query.isError) {
    return (
      <PageShell title="Order" breadcrumbs={crumbs} width="wide">
        <ErrorState message="The order could not be loaded." onRetry={() => query.refetch()} />
      </PageShell>
    );
  }
  return <OrderDetail key={query.data.id} order={query.data} />;
}

const scrollToInvoice = () =>
  document.getElementById('invoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

function OrderDetail({ order }: { order: Order }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const notify = useNotify();
  const key = useOperationKeys();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<OrderItem | null>(null);
  const [removing, setRemoving] = useState<OrderItem | null>(null);
  const close = () => setDialog(null);
  const can = (permission: PermissionId) => hasPermission(user, permission);
  const draft = order.status === 'draft';
  const items = activeItems(order);
  const canWrite = can(PermissionId.orderswrite);
  const canReadInventory = can(PermissionId.inventoryread);
  const canReadJobs = can(PermissionId.machine_jobsread);
  const canFinalize = can(PermissionId.ordersfinalize);
  const canReadPayments = can(PermissionId.paymentsread);
  const recorded = can(PermissionId.paymentsrecord) && canReadPayments;
  const canInvoiceManage =
    can(PermissionId.external_invoice_requestsmanage) && can(PermissionId.external_invoice_requestsread);
  const changed = items.filter((item) => item.sourceChanged);
  const original = useQuery({ ...orderQuery(order.replacesOrderId ?? ''), enabled: !!order.replacesOrderId && draft });
  const paymentRows = useOrderPaymentRows(order, canReadPayments);
  const outstanding = toCents(order.outstandingAmount);
  const hasRequest = !!order.activeExternalRequestId;
  const accepts = acceptsCashAndCard(order);

  const command = (action: string, extra: object = {}, version = order.version) => {
    const input = { expectedVersion: version, ...extra };
    return { ...input, operationKey: key(action, input) };
  };
  const mutation = useFinanceMutation(
    async (run: () => Promise<unknown>) => run(),
    () => close(),
  );
  const refreshChanged = () =>
    mutation.mutate(async () => {
      // Each refresh moves the order version on, so the next one is sent with the version the last one returned.
      let version = order.version;
      for (const item of changed)
        version = (await refreshOrderItem(order.id, item.id, command(`refresh-${item.id}`, {}, version))).version;
      notify({
        kind: 'success',
        title: changed.length === 1 ? 'Job refreshed' : 'Jobs refreshed',
        subtitle: 'The items now have the jobs’ current prices.',
      });
    });

  const draftBlockers = draft
    ? [
        items.length === 0 && 'Add at least one item.',
        changed.length > 0 &&
          `${changed.map((item) => item.snapshot?.displayId).join(', ')} changed since ${changed.length === 1 ? 'it was' : 'they were'} added. Refresh ${changed.length === 1 ? 'it' : 'them'} first.`,
      ].filter((value): value is string => !!value)
    : [];

  // The primary action depends on where the order is in its life.
  let primary: { label: string; icon?: typeof Currency; disabled?: boolean; run: () => void } | null = null;
  if (draft && order.replacesOrderId)
    primary =
      canFinalize && can(PermissionId.ordersreverse) && original.data
        ? { label: 'Commit replacement…', disabled: draftBlockers.length > 0, run: () => setDialog('correct') }
        : null;
  else if (draft && canFinalize && recorded)
    primary = {
      label: 'Finalize and take payment',
      icon: Currency,
      disabled: draftBlockers.length > 0,
      run: () => setDialog('checkout'),
    };
  else if (draft && canFinalize)
    primary = { label: 'Finalize', disabled: draftBlockers.length > 0, run: () => setDialog('finalize') };
  else if (order.status === 'finalized' && outstanding > 0 && recorded && accepts)
    primary = { label: 'Record payment', icon: Currency, run: () => setDialog('pay') };
  else if (order.status === 'reversed' && order.replacedByOrderId)
    primary = {
      label: `Open ${order.replacedByOrderReference}`,
      run: () => navigate(`/orders/${order.replacedByOrderId}`),
    };

  // Taking payment is optional: with payment rights "Finalize" stays available next to "Finalize and take payment".
  const finalizeWithoutPayment =
    draft && !order.replacesOrderId && canFinalize && recorded
      ? { label: 'Finalize', disabled: draftBlockers.length > 0, run: () => setDialog('finalize') }
      : null;
  const canPay = order.status === 'finalized' && outstanding > 0 && recorded && accepts;

  const canCorrect =
    (order.status === 'finalized' || order.status === 'reversed') &&
    !order.replacedByOrderId &&
    can(PermissionId.ordersreverse);
  const canReplace =
    (order.status === 'finalized' || order.status === 'reversed') && !order.replacedByOrderId && canWrite;
  const menu = [
    draft && canWrite && (
      <OverflowMenuItem key="edit" itemText="Edit customer and hand-over" onClick={() => setDialog('edit')} />
    ),
    canReplace && (
      <OverflowMenuItem
        key="replacement"
        itemText="Create replacement draft"
        onClick={() =>
          mutation.mutate(async () => {
            const next = await createReplacementOrder(order.id, command('replacement'));
            navigate(`/orders/${next.id}`);
          })
        }
      />
    ),
    canCorrect && <OverflowMenuItem key="correct" itemText="Correct order…" onClick={() => setDialog('correct')} />,
    draft && canWrite && (
      <OverflowMenuItem key="cancel" itemText="Cancel draft" isDelete hasDivider onClick={() => setDialog('cancel')} />
    ),
  ].filter(Boolean);

  const blocker = invoiceRequestBlocker(order);
  const canRequestInvoice = order.status === 'finalized' && canInvoiceManage && blocker === null;
  const invoiceAction =
    order.status !== 'finalized'
      ? null
      : order.latestExternalRequestId
        ? { label: 'View invoice', run: scrollToInvoice }
        : canRequestInvoice && outstanding === 0
          ? { label: 'Request invoice', run: () => setDialog('invoice') }
          : null;
  const state = order.activeExternalRequestState;
  const stateLabel = (requestStateLabel[state as keyof typeof requestStateLabel] ?? state ?? '').toLowerCase();
  const notice =
    hasRequest && !accepts && order.status === 'finalized' && outstanding > 0
      ? `${order.activeExternalRequestReference} is ${stateLabel}: cash and card can no longer be added. An issued invoice settles the balance by itself.`
      : null;

  const lastPayment = paymentRows.find((row) => row.payment && !row.reversal)?.payment;
  const attention = order.attention ?? [];
  const sourceChanged = attention.some((entry) => entry.code === 'source_changed');
  const invoiceOpen = attention.some((entry) => entry.code === 'invoice_request_open');
  const addable = draft && canWrite;
  const openAdd = (kind: AddItemKind) => {
    setEditing(null);
    setDialog(kind === 'job' ? 'jobs' : kind === 'stock' ? 'stock' : 'custom');
  };

  return (
    <PageShell
      className="sales-page"
      title={order.reference}
      titleAdornment={
        <span className="sales-inline">
          <OrderStatusTag order={order} />
          {order.latestExternalRequestState && <RequestStateTag state={order.latestExternalRequestState} size="md" />}
        </span>
      }
      width="wide"
      description={`${customerLabel(order)} · created ${formatDateTime(order.createdAt)}${order.createdBy ? ` by ${order.createdBy.displayName}` : ''}`}
      breadcrumbs={crumbs}
      actions={
        <>
          {canPrintReceipt(order) && canReadPayments && (
            <Button kind="tertiary" renderIcon={Printer} onClick={() => navigate(`/orders/${order.id}/receipt`)}>
              Print receipt
            </Button>
          )}
          {invoiceAction && (
            <Button kind="secondary" renderIcon={DocumentIcon} onClick={invoiceAction.run}>
              {invoiceAction.label}
            </Button>
          )}
          {finalizeWithoutPayment && (
            <Button kind="secondary" disabled={finalizeWithoutPayment.disabled} onClick={finalizeWithoutPayment.run}>
              {finalizeWithoutPayment.label}
            </Button>
          )}
          {primary && (
            <Button kind="primary" renderIcon={primary.icon} disabled={primary.disabled} onClick={primary.run}>
              {primary.label}
            </Button>
          )}
          {menu.length > 0 && (
            <OverflowMenu aria-label="More order actions" iconDescription="More order actions" flipped>
              {menu}
            </OverflowMenu>
          )}
        </>
      }
    >
      <div className="sales-stack">
        {order.replacesOrderId && draft && (
          <RichNotification kind="info" title="This draft replaces an order">
            <RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />. Change
            the items as needed, then commit the replacement. The original is reversed at that moment and its payments
            move over.
          </RichNotification>
        )}
        {order.replacedByOrderId && (
          <RichNotification kind="info" title="This order was replaced">
            <RefLink reference={order.replacedByOrderReference ?? ''} id={order.replacedByOrderId} kind="order" /> is
            charged now. This order no longer counts; its payments moved over.
          </RichNotification>
        )}
        {order.replacesOrderId && !draft && (
          <RichNotification kind="info" title="This order replaces another one">
            <RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />. Payments
            that were already made moved over to this order.
          </RichNotification>
        )}
        {attention.length > 0 && (
          <RichNotification kind="warning" title="Needs attention">
            {attention.map((entry) => entry.message).join(' · ')}
            {sourceChanged && !draft && ' The order keeps the original charge; to change it, use Correct order.'}
            {((sourceChanged && draft && canWrite) || canPay || invoiceOpen) && (
              <span className="sales-notice-actions">
                {sourceChanged && draft && canWrite && (
                  <Button
                    kind="ghost"
                    size="sm"
                    renderIcon={Renew}
                    disabled={mutation.isPending}
                    onClick={refreshChanged}
                  >
                    Refresh prices from the jobs
                  </Button>
                )}
                {canPay && (
                  <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setDialog('pay')}>
                    Take payment
                  </Button>
                )}
                {invoiceOpen && (
                  <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={scrollToInvoice}>
                    Review invoice
                  </Button>
                )}
              </span>
            )}
          </RichNotification>
        )}
        {draftBlockers.length > 0 && (
          <RichNotification kind="warning" title="Before you can continue">
            {draftBlockers.join(' ')}
          </RichNotification>
        )}
        {mutation.error && (
          <RichNotification kind="error" title="That did not work">
            <OrderErrorText error={mutation.error} order={order} />
          </RichNotification>
        )}

        <FactTiles
          label="Order facts"
          items={[
            {
              label: order.status === 'reversed' ? 'Total (reversed)' : 'Total',
              value: formatCents(toCents(order.totalAmount)),
              helper:
                order.netCharge !== order.totalAmount
                  ? `Net charge ${formatCents(toCents(order.netCharge))} after reversal`
                  : `${items.length} ${items.length === 1 ? 'item' : 'items'}${draft ? ' · prices not frozen yet' : ''}`,
            },
            {
              label: 'Paid',
              value: formatCents(toCents(order.settledAmount)),
              helper: lastPayment
                ? `${methodLabel(lastPayment.method)} · ${formatDateTime(lastPayment.occurredAt)}`
                : 'No payment yet',
            },
            {
              label: 'Outstanding',
              value: draft ? '—' : formatCents(outstanding),
              helper: draft ? 'Finalize to charge' : outstanding > 0 ? 'Net charge minus payments' : 'Settled',
            },
            { label: 'Customer', value: customerLabel(order), helper: customerKindLabel(order.customerKind) },
            {
              label: 'Hand-over',
              value: order.fulfillmentMode === 'immediate' ? 'Handed over' : 'Later',
              helper: order.fulfillmentMode === 'immediate' ? 'Taken along on the day' : 'Pick-up or shipping later',
            },
            {
              label: 'Created',
              value: formatDateTime(order.createdAt),
              helper: order.createdBy ? `by ${order.createdBy.displayName}` : undefined,
            },
          ]}
        />

        <div className="sales-detail">
          <div className="sales-stack">
            <OrderItemsTable
              order={order}
              editable={addable}
              busy={mutation.isPending}
              canReadInventory={canReadInventory}
              action={
                addable ? (
                  <Button kind="primary" size="md" renderIcon={Add} onClick={() => setDialog('add')}>
                    Add item
                  </Button>
                ) : undefined
              }
              onRefresh={(item) =>
                mutation.mutate(async () => {
                  await refreshOrderItem(order.id, item.id, command(`refresh-${item.id}`));
                  notify({
                    kind: 'success',
                    title: 'Job refreshed',
                    subtitle: 'The item now has the job’s current price.',
                  });
                })
              }
              onRemove={(item) => {
                mutation.reset();
                setRemoving(item);
              }}
              onEdit={(item) => {
                setEditing(item);
                setDialog(item.kind === 'inventory_item' ? 'stock' : 'custom');
              }}
            />
            {canReadPayments && (
              <PaymentsSection
                order={order}
                rows={paymentRows}
                notice={notice}
                action={
                  canPay ? (
                    <Button kind="primary" size="md" renderIcon={Add} onClick={() => setDialog('pay')}>
                      Record
                    </Button>
                  ) : undefined
                }
              />
            )}
            <InvoiceSection order={order} />
          </div>
          <div className="sales-stack">
            <BalanceCard
              order={order}
              rows={paymentRows}
              action={
                canPay ? (
                  <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setDialog('pay')}>
                    Take payment
                  </Button>
                ) : canRequestInvoice && outstanding === 0 && !order.latestExternalRequestId ? (
                  <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setDialog('invoice')}>
                    Request an invoice
                  </Button>
                ) : undefined
              }
            />
            <CustomerCard
              order={order}
              action={
                addable ? (
                  <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setDialog('edit')}>
                    Edit
                  </Button>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>

      {dialog === 'edit' && <EditOrderModal order={order} onClose={close} onSaved={() => undefined} />}
      {dialog === 'add' && (
        <AddItemModal
          order={order}
          canJobs={canReadJobs}
          canStock={canReadInventory}
          onClose={close}
          onChoose={openAdd}
        />
      )}
      {dialog === 'jobs' && <AddJobsModal order={order} onClose={close} />}
      {dialog === 'stock' && <InventoryItemModal order={order} item={editing} onClose={close} />}
      {dialog === 'custom' && <CustomItemModal order={order} item={editing} onClose={close} />}
      {dialog === 'pay' && (
        <RecordPaymentModal
          order={order}
          mode="record"
          onClose={close}
          onRequestInvoice={canRequestInvoice ? () => setDialog('invoice') : undefined}
        />
      )}
      {dialog === 'checkout' && (
        <RecordPaymentModal
          order={order}
          mode="checkout"
          onClose={close}
          onRequestInvoice={canInvoiceManage ? () => setDialog('invoice') : undefined}
        />
      )}
      {dialog === 'invoice' && <RequestInvoiceModal order={order} onClose={close} />}
      {dialog === 'correct' && !order.replacesOrderId && (
        <CorrectOrderModal
          order={order}
          canReversePayments={can(PermissionId.paymentsreverse) && canReadPayments}
          canCarry={canFinalize && recorded}
          onClose={close}
        />
      )}
      {dialog === 'correct' && order.replacesOrderId && original.data && (
        <CorrectOrderModal
          order={original.data}
          initialReplacementId={order.id}
          canReversePayments={can(PermissionId.paymentsreverse) && canReadPayments}
          canCarry={canFinalize && recorded}
          onClose={close}
        />
      )}
      {dialog === 'finalize' && (
        <Modal
          open
          size="sm"
          modalHeading="Finalize order"
          modalLabel={order.reference}
          primaryButtonText={mutation.isPending ? 'Finalizing…' : 'Finalize'}
          secondaryButtonText="Cancel"
          preventCloseOnClickOutside
          onRequestClose={close}
          primaryButtonDisabled={mutation.isPending}
          onRequestSubmit={() =>
            mutation.mutate(async () => {
              await finalizeOrder(order.id, command('finalize'));
              notify({ kind: 'success', title: `${order.reference} finalized` });
            })
          }
        >
          <Stack gap={4}>
            <p>
              Prices and items freeze, the jobs on this order are reserved for it, and stock items leave inventory.
              Total: <strong>{formatCents(toCents(order.totalAmount))}</strong> for {customerLabel(order)}.
            </p>
            <p>No payment is taken now. The full total stays outstanding and can be paid later from the order.</p>
            <p className="sales-secondary">
              Later changes need a correction, which reverses this order and creates a replacement.
            </p>
            {mutation.error && (
              <RichNotification kind="error" title="Could not finalize">
                <OrderErrorText error={mutation.error} order={order} />
              </RichNotification>
            )}
          </Stack>
        </Modal>
      )}
      <DestructiveActionDialog
        open={dialog === 'cancel'}
        title="Cancel this draft?"
        fate="none"
        confirmLabel="Cancel draft"
        cancelLabel="Keep draft"
        pending={mutation.isPending}
        error={mutation.error?.message}
        onClose={close}
        onConfirm={() =>
          mutation.mutate(async () => {
            await cancelOrder(order.id, command('cancel'));
            notify({
              kind: 'success',
              title: 'Draft cancelled',
              subtitle: `${order.reference} was never charged; its jobs are free again.`,
            });
          })
        }
      >
        <p>
          {order.reference} was never finalized, so nothing was charged. The draft is kept as cancelled and its jobs can
          go on another order.
        </p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={!!removing}
        title="Remove item from draft?"
        fate="permanent"
        confirmLabel="Remove item"
        pending={mutation.isPending}
        error={mutation.error?.message}
        onClose={() => {
          setRemoving(null);
          mutation.reset();
        }}
        onConfirm={() =>
          mutation.mutate(async () => {
            await removeOrderItem(order.id, removing!.id, command(`remove-${removing!.id}`));
            setRemoving(null);
          })
        }
      >
        <p>
          {removing?.description} will be removed from this draft and excluded from its total. Other items are
          unchanged.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}
