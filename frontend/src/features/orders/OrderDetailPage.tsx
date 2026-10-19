import { useState } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem, Modal, OverflowMenu, OverflowMenuItem, Stack, Tile } from '@carbon/react';
import { Currency, Document as DocumentIcon, Printer } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cancelOrder, createReplacementOrder, finalizeOrder, refreshOrderItem, removeOrderItem } from '../../api/generated/orders/orders';
import type { Order, OrderItem } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { CorrectOrderModal } from './CorrectOrderModal';
import { InvoiceSection } from './InvoiceSection';
import { acceptsCashAndCard, activeItems, canPrintReceipt, customerLabel, invoiceRequestBlocker } from './logic';
import { customerKindLabel, requestStateLabel } from './labels';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { AddJobsModal, CustomItemModal, EditOrderModal } from './OrderDialogs';
import { OrderItemsTable } from './OrderItemsTable';
import { PaymentsSection } from './PaymentsSection';
import { orderQuery, useFinanceMutation } from './queries';
import { RecordPaymentModal } from './RecordPaymentModal';
import { RequestInvoiceModal } from './RequestInvoiceModal';
import { OrderStatusTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

type Dialog = 'edit' | 'jobs' | 'custom' | 'finalize' | 'cancel' | 'pay' | 'checkout' | 'correct' | 'invoice' | null;
const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders', to: '/orders' }];

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
  const canFinalize = can(PermissionId.ordersfinalize);
  const recorded = can(PermissionId.paymentsrecord) && can(PermissionId.paymentsread);
  const canInvoiceManage = can(PermissionId.external_invoice_requestsmanage) && can(PermissionId.external_invoice_requestsread);
  const changed = items.filter((item) => item.sourceChanged);
  const original = useQuery({ ...orderQuery(order.replacesOrderId ?? ''), enabled: !!order.replacesOrderId && draft });
  const outstanding = toCents(order.outstandingAmount);
  const hasRequest = !!order.activeExternalRequestId;
  const accepts = acceptsCashAndCard(order);

  const command = (action: string, extra: object = {}) => { const input = { expectedVersion: order.version, ...extra }; return { ...input, operationKey: key(action, input) }; };
  const mutation = useFinanceMutation(async (run: () => Promise<unknown>) => run(), () => close());

  const draftBlockers = draft ? [
    items.length === 0 && 'Add at least one item.',
    changed.length > 0 && `${changed.map((item) => item.snapshot?.displayId).join(', ')} changed since ${changed.length === 1 ? 'it was' : 'they were'} added. Refresh ${changed.length === 1 ? 'it' : 'them'} first.`,
  ].filter((value): value is string => !!value) : [];

  // The primary action depends on where the order is in its life.
  let primary: { label: string; icon?: typeof Currency; disabled?: boolean; run: () => void } | null = null;
  if (draft && order.replacesOrderId) primary = canFinalize && can(PermissionId.ordersreverse) && original.data ? { label: 'Commit replacement…', disabled: draftBlockers.length > 0, run: () => setDialog('correct') } : null;
  else if (draft && canFinalize && recorded) primary = { label: 'Finalize and take payment', icon: Currency, disabled: draftBlockers.length > 0, run: () => setDialog('checkout') };
  else if (draft && canFinalize) primary = { label: 'Finalize', disabled: draftBlockers.length > 0, run: () => setDialog('finalize') };
  else if (order.status === 'finalized' && outstanding > 0 && recorded && accepts) primary = { label: 'Record payment', icon: Currency, run: () => setDialog('pay') };
  else if (order.status === 'reversed' && order.replacedByOrderId) primary = { label: `Open ${order.replacedByOrderReference}`, run: () => navigate(`/orders/${order.replacedByOrderId}`) };

  const canCorrect = (order.status === 'finalized' || order.status === 'reversed') && !order.replacedByOrderId && can(PermissionId.ordersreverse);
  const canReplace = (order.status === 'finalized' || order.status === 'reversed') && !order.replacedByOrderId && canWrite;
  const menu = [
    draft && canWrite && <OverflowMenuItem key="edit" itemText="Edit customer and hand-over" onClick={() => setDialog('edit')} />,
    canReplace && <OverflowMenuItem key="replacement" itemText="Create replacement draft" onClick={() => mutation.mutate(async () => { const next = await createReplacementOrder(order.id, command('replacement')); navigate(`/orders/${next.id}`); })} />,
    canCorrect && <OverflowMenuItem key="correct" itemText="Correct order…" onClick={() => setDialog('correct')} />,
    draft && canWrite && <OverflowMenuItem key="cancel" itemText="Cancel draft" isDelete hasDivider onClick={() => setDialog('cancel')} />,
  ].filter(Boolean);

  const blocker = invoiceRequestBlocker(order);
  const canRequestInvoice = order.status === 'finalized' && canInvoiceManage && blocker === null;
  const invoiceAction = order.status !== 'finalized' ? null
    : order.latestExternalRequestId ? { label: 'View invoice', run: () => document.getElementById('invoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
      : canRequestInvoice && outstanding === 0 ? { label: 'Request invoice', run: () => setDialog('invoice') } : null;
  const state = order.activeExternalRequestState;
  const notice = hasRequest && !accepts && order.status === 'finalized'
    ? `${order.activeExternalRequestReference} is ${(requestStateLabel[state as keyof typeof requestStateLabel] ?? state ?? '').toLowerCase()}: cash and card can no longer be added. An issued invoice settles the balance by itself.` : null;

  return (
    <PageShell
      className="sales-page" title={order.reference} titleAdornment={<OrderStatusTag order={order} />} width="wide"
      description={`${customerLabel(order)} · created ${formatDateTime(order.createdAt)}${order.createdBy ? ` by ${order.createdBy.displayName}` : ''}`} breadcrumbs={crumbs}
      actions={<>
        {canPrintReceipt(order) && can(PermissionId.paymentsread) && <Button kind="tertiary" renderIcon={Printer} onClick={() => navigate(`/orders/${order.id}/receipt`)}>Print receipt</Button>}
        {invoiceAction && <Button kind="secondary" renderIcon={DocumentIcon} onClick={invoiceAction.run}>{invoiceAction.label}</Button>}
        {primary && <Button kind="primary" renderIcon={primary.icon} disabled={primary.disabled} onClick={primary.run}>{primary.label}</Button>}
        {menu.length > 0 && <OverflowMenu aria-label="More order actions" iconDescription="More order actions" flipped>{menu}</OverflowMenu>}
      </>}
    >
      <div className="mj-stack">
        {order.replacesOrderId && draft && (
          <RichNotification kind="info" title="This draft replaces an order"><RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />. Change the items as needed, then commit the replacement. The original is reversed at that moment and its payments move over.</RichNotification>
        )}
        {order.replacedByOrderId && <RichNotification kind="info" title="This order was replaced"><RefLink reference={order.replacedByOrderReference ?? ''} id={order.replacedByOrderId} kind="order" /> is charged now. This order no longer counts.</RichNotification>}
        {order.replacesOrderId && !draft && <RichNotification kind="info" title="This order replaces another one"><RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />. Payments that were already made moved over to this order.</RichNotification>}
        {draftBlockers.length > 0 && <RichNotification kind="warning" title="Before you can continue">{draftBlockers.join(' ')}</RichNotification>}
        {!draft && changed.length > 0 && <RichNotification kind="warning" title={`${changed.length === 1 ? 'A job' : `${changed.length} jobs`} changed after being charged`}>The order keeps the original charge. To change what is charged, use Correct order in the menu.</RichNotification>}
        {mutation.error && <RichNotification kind="error" title="That did not work">{mutation.error.message}</RichNotification>}

        <section className="sales-tiles" aria-label="Amounts">
          <Tile className="sales-tile"><span className="sales-tile__label">{order.status === 'reversed' ? 'Total (reversed)' : 'Total'}</span><span className="sales-tile__value">{formatCents(toCents(order.totalAmount))}</span>
            <span className="mj-secondary">{order.netCharge !== order.totalAmount ? `Net charge ${formatCents(toCents(order.netCharge))} after reversal` : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Paid</span><span className="sales-tile__value">{formatCents(toCents(order.settledAmount))}</span><span className="mj-secondary">Payments counting towards this order</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Outstanding</span><span className={`sales-tile__value${outstanding > 0 && !draft ? ' sales-num--due' : ''}`}>{draft ? '—' : formatCents(outstanding)}</span>
            <span className="mj-secondary">{draft ? 'Not charged yet' : 'Net charge minus payments'}</span></Tile>
        </section>

        <div className="mj-detail-layout">
          <div className="mj-stack">
            {draft && canWrite && (
              <div className="sales-section-actions">
                <MenuButton label="Add items" kind="tertiary" size="md" menuAlignment="bottom-start">
                  {can(PermissionId.machine_jobsread) ? <MenuItem label="Jobs…" onClick={() => setDialog('jobs')} /> : null}
                  <MenuItem label="Custom item…" onClick={() => { setEditing(null); setDialog('custom'); }} />
                </MenuButton>
              </div>
            )}
            <OrderItemsTable
              order={order} editable={draft && canWrite} busy={mutation.isPending}
              onRefresh={(item) => mutation.mutate(async () => { await refreshOrderItem(order.id, item.id, command(`refresh-${item.id}`)); notify({ kind: 'success', title: 'Job refreshed', subtitle: 'The item now has the job’s current price.' }); })}
              onRemove={(item) => { mutation.reset(); setRemoving(item); }}
              onEdit={(item) => { setEditing(item); setDialog('custom'); }}
            />
            <PaymentsSection order={order} notice={notice} canRead={can(PermissionId.paymentsread)} />
            <InvoiceSection order={order} />
          </div>
          <div className="mj-stack">
            <Tile>
              <h2 className="mj-section-title">Details</h2>
              <dl className="mj-facts sales-facts">
                <div><dt>Customer</dt><dd>
                  {order.customer ? <CarbonLink as={Link} to={`/orders?customer=${order.customer.id}`}>{customerLabel(order)}</CarbonLink> : customerLabel(order)}
                  <br /><span className="mj-secondary">{customerKindLabel(order.customerKind)}{order.customer ? ' · all their orders' : ''}</span></dd></div>
                <div><dt>Hand-over</dt><dd>{order.fulfillmentMode === 'immediate' ? 'Handed over now' : 'Customer picks up later'}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(order.createdAt)}</dd></div>
                <div><dt>Last change</dt><dd>{formatDateTime(order.updatedAt)}</dd></div>
                {order.latestExternalRequestReference && <div><dt>Invoice request</dt><dd>{order.latestExternalRequestReference}{order.latestExternalRequestState === 'cancelled' && <span className="mj-secondary"> · cancelled</span>}</dd></div>}
                {order.adjustments.map((adjustment) => <div key={adjustment.id}><dt>{adjustment.reference}</dt><dd>Full reversal · {formatCents(toCents(adjustment.amount))}<br /><span className="mj-secondary">{adjustment.reason}</span></dd></div>)}
              </dl>
            </Tile>
          </div>
        </div>
      </div>

      {dialog === 'edit' && <EditOrderModal order={order} onClose={close} onSaved={() => undefined} />}
      {dialog === 'jobs' && <AddJobsModal order={order} onClose={close} />}
      {dialog === 'custom' && <CustomItemModal order={order} item={editing} onClose={close} />}
      {dialog === 'pay' && <RecordPaymentModal order={order} mode="record" onClose={close} onRequestInvoice={canRequestInvoice ? () => setDialog('invoice') : undefined} />}
      {dialog === 'checkout' && <RecordPaymentModal order={order} mode="checkout" onClose={close} onRequestInvoice={canInvoiceManage ? () => setDialog('invoice') : undefined} />}
      {dialog === 'invoice' && <RequestInvoiceModal order={order} onClose={close} />}
      {dialog === 'correct' && !order.replacesOrderId && <CorrectOrderModal order={order} canReversePayments={can(PermissionId.paymentsreverse) && can(PermissionId.paymentsread)} canCarry={canFinalize && recorded} onClose={close} />}
      {dialog === 'correct' && order.replacesOrderId && original.data && (
        <CorrectOrderModal order={original.data} initialReplacementId={order.id} canReversePayments={can(PermissionId.paymentsreverse) && can(PermissionId.paymentsread)} canCarry={canFinalize && recorded} onClose={close} />
      )}
      {dialog === 'finalize' && (
        <Modal open size="sm" modalHeading="Finalize order" modalLabel={order.reference} primaryButtonText={mutation.isPending ? 'Finalizing…' : 'Finalize'} secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={close}
          primaryButtonDisabled={mutation.isPending}
          onRequestSubmit={() => mutation.mutate(async () => { await finalizeOrder(order.id, command('finalize')); notify({ kind: 'success', title: `${order.reference} finalized` }); })}>
          <Stack gap={4}>
            <p>Prices and items freeze, and the jobs on this order are reserved for it. Total: <strong>{formatCents(toCents(order.totalAmount))}</strong> for {customerLabel(order)}.</p>
            <p className="mj-secondary">Later changes need a correction, which reverses this order and creates a replacement.</p>
          </Stack>
        </Modal>
      )}
      <DestructiveActionDialog open={dialog === 'cancel'} title="Cancel this draft?" confirmLabel="Cancel draft" cancelLabel="Keep draft" pending={mutation.isPending} error={mutation.error?.message} onClose={close}
        onConfirm={() => mutation.mutate(async () => { await cancelOrder(order.id, command('cancel')); notify({ kind: 'success', title: 'Draft cancelled', subtitle: `${order.reference} was never charged; its jobs are free again.` }); })}>
        <p>{order.reference} was never finalized, so nothing was charged. The draft is kept as cancelled and its jobs can go on another order.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog open={!!removing} title="Remove item from draft?" confirmLabel="Remove item" pending={mutation.isPending} error={mutation.error?.message} onClose={() => { setRemoving(null); mutation.reset(); }}
        onConfirm={() => mutation.mutate(async () => { await removeOrderItem(order.id, removing!.id, command(`remove-${removing!.id}`)); setRemoving(null); })}>
        <p>{removing?.description} will be removed from this draft and excluded from its total. Other items are unchanged.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

