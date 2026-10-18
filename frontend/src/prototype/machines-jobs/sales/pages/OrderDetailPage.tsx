import { useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, MenuButton, MenuItem, Modal, OverflowMenu, OverflowMenuItem, Stack, Tile } from '@carbon/react';
import { Add, Currency, Printer } from '@carbon/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../../app/DestructiveActionDialog';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { OrderItemsTable } from '../components/OrderItemsTable';
import { OrderTimeline } from '../components/OrderTimeline';
import { PaymentsSection } from '../components/PaymentsSection';
import { RequirePermission } from '../components/RequirePermission';
import { AddItemModal } from '../dialogs/AddItemModal';
import { AddJobsModal } from '../dialogs/AddJobsModal';
import { CorrectOrderModal } from '../dialogs/CorrectOrderModal';
import { EditOrderModal } from '../dialogs/EditOrderModal';
import { PrepareRequestModal } from '../dialogs/PrepareRequestModal';
import { RecordPaymentModal } from '../dialogs/RecordPaymentModal';
import { formatDateTime, formatEur } from '../format';
import { requestStateLabel } from '../labels';
import { activeItems, activeReceipts, itemChanged, type OrderView } from '../logic';
import { OrderStatusTag } from '../status';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

type Dialog = 'edit' | 'jobs' | 'catalog' | 'custom' | 'finalize' | 'cancel' | 'pay' | 'checkout' | 'correct' | 'commit' | 'request' | null;

function OrderDetail({ order, views }: { order: OrderView; views: OrderView[] }) {
  const store = useStore();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const draft = order.status === 'draft';
  const items = activeItems(order);
  const walkIn = !order.customer;
  const can = store.can;
  const canWrite = can('orders.write');
  const request = order.activeRequest;
  const original = order.replaces ? views.find((candidate) => candidate.id === order.replaces!.id) ?? null : null;
  const changedItems = items.filter((item) => itemChanged(item, store.jobs));
  const receipts = activeReceipts(store.payments, store.allocations, order.id);
  const recorded = can('payments.record') && can('payments.read');

  const act = (fn: () => unknown, success?: { title: string; subtitle?: string }) => {
    try { fn(); if (success) store.notify({ kind: 'success', ...success }); } catch (error) { store.notify({ kind: 'error', title: 'That did not work', subtitle: error instanceof Error ? error.message : undefined }); }
  };

  const draftBlockers = draft ? [
    items.length === 0 && 'Add at least one item.',
    changedItems.length > 0 && `${changedItems.map((item) => item.snapshot?.displayId).join(', ')} changed since ${changedItems.length === 1 ? 'it was' : 'they were'} added. Refresh ${changedItems.length === 1 ? 'it' : 'them'} first.`,
  ].filter((value): value is string => !!value) : [];

  // The primary action depends on where the order is in its life.
  let primary: { label: string; icon?: typeof Add; disabled?: boolean; run: () => void } | null = null;
  if (draft && order.replacesOrderId) primary = canWrite && can('orders.finalize') && can('orders.reverse') && recorded ? { label: 'Commit replacement…', disabled: draftBlockers.length > 0, run: () => setDialog('commit') } : null;
  else if (draft && walkIn) primary = can('orders.finalize') && recorded ? { label: 'Check out', icon: Currency, disabled: draftBlockers.length > 0, run: () => setDialog('checkout') } : null;
  else if (draft) primary = can('orders.finalize') ? { label: 'Finalize', disabled: draftBlockers.length > 0, run: () => setDialog('finalize') } : null;
  else if (order.status === 'finalized' && order.outstanding > 0 && recorded && (!request || request.state === 'issued')) primary = { label: request ? 'Record wiRef payment' : 'Record payment', icon: Currency, run: () => setDialog('pay') };
  else if (order.status === 'finalized' && order.outstanding > 0 && request) primary = { label: 'Open wiRef request', run: () => navigate(`/sales/invoicing/${request.id}`) };
  else if (order.status === 'finalized') primary = { label: 'Print receipt', icon: Printer, run: () => navigate(`/sales/orders/${order.id}/receipt`) };
  else if (order.status === 'reversed' && order.replacedBy) primary = { label: `Open ${order.replacedBy.reference}`, run: () => navigate(`/sales/orders/${order.replacedBy!.id}`) };
  else if (order.status === 'reversed' && canWrite && can('orders.finalize') && can('orders.reverse')) primary = { label: 'Replace with a corrected order', run: () => setDialog('correct') };
  else if ((order.status === 'cancelled') && canWrite) primary = { label: 'Duplicate as draft', run: () => act(() => navigate(`/sales/orders/${store.duplicateOrder(order.id).orderId}`)) };

  const canCorrect = (order.status === 'finalized' || order.status === 'reversed') && can('orders.finalize') && (can('orders.reverse') || order.status === 'reversed') && recorded && !order.replacedBy;
  const menu = [
    draft && canWrite && <OverflowMenuItem key="edit" itemText="Edit customer and hand-over" onClick={() => setDialog('edit')} />,
    canCorrect && <OverflowMenuItem key="correct" itemText="Correct order…" onClick={() => setDialog('correct')} />,
    order.status === 'finalized' && !walkIn && can('external_invoice_requests.manage') && !request && receipts.length === 0 && <OverflowMenuItem key="request" itemText="Prepare wiRef request" onClick={() => setDialog('request')} />,
    order.status === 'finalized' && order.net > 0 && receipts.length > 0 && primary?.label !== 'Print receipt' && <OverflowMenuItem key="receipt" itemText="Print receipt" onClick={() => navigate(`/sales/orders/${order.id}/receipt`)} />,
    !draft && canWrite && order.status !== 'cancelled' && primary?.label !== 'Duplicate as draft' && <OverflowMenuItem key="duplicate" itemText="Duplicate as draft" onClick={() => act(() => navigate(`/sales/orders/${store.duplicateOrder(order.id).orderId}`))} />,
    draft && canWrite && <OverflowMenuItem key="cancel" itemText="Cancel draft" isDelete hasDivider onClick={() => setDialog('cancel')} />,
  ].filter(Boolean);

  const recordBlocked = request && request.state !== 'issued' ? `${request.reference} is ${requestStateLabel[request.state].toLowerCase()}: cash and card are switched off.` : null;

  return (
    <PageShell
      title={order.reference} titleAdornment={<OrderStatusTag order={order} />} width="wide"
      description={`${order.customerLabel} · created ${formatDateTime(order.createdAt)} by ${order.createdBy}`}
      breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders', to: '/sales/orders' }]}
      actions={<>
        {primary && <Button kind="primary" renderIcon={primary.icon} disabled={primary.disabled} onClick={primary.run}>{primary.label}</Button>}
        {menu.length > 0 && <OverflowMenu aria-label="More order actions" iconDescription="More order actions" flipped>{menu}</OverflowMenu>}
      </>}
    >
      <div className="mj-stack">
        {order.replaces && draft && (
          <InlineNotification kind="info" lowContrast hideCloseButton title={`This draft replaces ${order.replaces.reference}`}
            subtitle="Change the items as needed, then commit the replacement. The original is reversed at that moment and its payments move over." />
        )}
        {order.replacedBy && <InlineNotification kind="info" lowContrast hideCloseButton title={`Replaced by ${order.replacedBy.reference}`} subtitle="This order no longer counts. Open the replacement to see what is charged now." />}
        {order.replaces && !draft && <InlineNotification kind="info" lowContrast hideCloseButton title={`Replaces ${order.replaces.reference}`} subtitle="Payments that were already made moved over to this order." />}
        {request && (
          <InlineNotification kind="info" lowContrast hideCloseButton title={`Invoicing via wiRef: ${request.reference} (${requestStateLabel[request.state].toLowerCase()})`}
            subtitle={request.state === 'issued' ? 'wiRef issued the invoice. Record the payment here once it is confirmed.' : 'Cash and card are switched off while the request is active.'}>
            <Button as={Link} to={`/sales/invoicing/${request.id}`} kind="ghost" size="sm">Open request</Button>
          </InlineNotification>
        )}
        {draftBlockers.length > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton title="Before you can continue" subtitle={draftBlockers.join(' ')} />}
        {!draft && changedItems.length > 0 && (
          <InlineNotification kind="warning" lowContrast hideCloseButton title={`${changedItems.length === 1 ? 'A job' : `${changedItems.length} jobs`} changed after being charged`}
            subtitle="The order keeps the original charge. To change what is charged, use Correct order in the menu." />
        )}

        <section className="sales-tiles" aria-label="Amounts">
          <Tile className="sales-tile"><span className="sales-tile__label">{order.status === 'reversed' ? 'Total (reversed)' : 'Total'}</span><span className="sales-tile__value">{formatEur(order.total)}</span>
            <span className="mj-secondary">{order.net !== order.total ? `Net charge ${formatEur(order.net)} after reversal` : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Paid</span><span className="sales-tile__value">{formatEur(order.settled)}</span><span className="mj-secondary">{receipts.length} {receipts.length === 1 ? 'payment' : 'payments'} count towards this order</span></Tile>
          <Tile className="sales-tile"><span className={`sales-tile__label`}>Outstanding</span><span className={`sales-tile__value${order.outstanding > 0 ? ' sales-num--due' : ''}`}>{draft ? '—' : formatEur(order.outstanding)}</span>
            <span className="mj-secondary">{draft ? 'Not charged yet' : 'Net charge minus payments'}</span></Tile>
        </section>

        <div className="mj-detail-layout">
          <div className="mj-stack">
            {draft && canWrite && (
              <div className="sales-section-actions">
                <MenuButton label="Add items" kind="tertiary" size="md" menuAlignment="bottom-start">
                  <MenuItem label={walkIn ? 'Jobs (choose a customer first)' : 'Jobs…'} disabled={walkIn} onClick={() => setDialog('jobs')} />
                  <MenuItem label="Catalog item… (proposed)" onClick={() => setDialog('catalog')} />
                  <MenuItem label="Custom item…" onClick={() => setDialog('custom')} />
                </MenuButton>
              </div>
            )}
            <OrderItemsTable
              order={order} jobs={store.jobs} prints={store.prints} editable={draft && canWrite} busy={false}
              onRefresh={(item) => act(() => store.refreshOrderItem(order.id, item.id), { title: 'Job refreshed', subtitle: 'The item now has the job’s current price.' })}
              onRemove={(item) => act(() => store.removeOrderItem(order.id, item.id), { title: 'Item removed' })}
              onSave={(item, input) => act(() => store.updateOrderManualItem(order.id, item.id, input), { title: 'Item updated' })}
            />
            <PaymentsSection order={order} orders={store.orders} payments={store.payments} allocations={store.allocations} canRecord={recorded && order.status === 'finalized' && order.outstanding > 0 && (!request || request.state === 'issued')}
              recordBlocked={recordBlocked} onRecord={() => setDialog('pay')} />
          </div>
          <div className="mj-stack">
            <Tile>
              <h2 className="mj-section-title">Details</h2>
              <dl className="mj-facts sales-facts">
                <div><dt>Customer</dt><dd>{order.customer ? <CarbonLink as={Link} to={`/sales/customers/${order.customer.kind}/${order.customer.id}`}>{order.customerLabel}</CarbonLink> : 'Walk-in customer'}</dd></div>
                <div><dt>Hand-over</dt><dd>{order.fulfillmentMode === 'immediate' ? 'Handed over now' : 'Customer picks up later'}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(order.createdAt)}</dd></div>
                <div><dt>Last change</dt><dd>{formatDateTime(order.updatedAt)}</dd></div>
                {order.replaces && <div><dt>Replaces</dt><dd><CarbonLink as={Link} to={`/sales/orders/${order.replaces.id}`}>{order.replaces.reference}</CarbonLink></dd></div>}
                {order.replacedBy && <div><dt>Replaced by</dt><dd><CarbonLink as={Link} to={`/sales/orders/${order.replacedBy.id}`}>{order.replacedBy.reference}</CarbonLink></dd></div>}
                {order.latestRequest && <div><dt>wiRef request</dt><dd><CarbonLink as={Link} to={`/sales/invoicing/${order.latestRequest.id}`}>{order.latestRequest.reference}</CarbonLink></dd></div>}
              </dl>
            </Tile>
            <OrderTimeline order={order} />
          </div>
        </div>
      </div>

      {dialog === 'edit' && <EditOrderModal order={order} onClose={close} onSaved={() => undefined} />}
      {dialog === 'jobs' && <AddJobsModal order={order} onClose={close} />}
      {(dialog === 'catalog' || dialog === 'custom') && <AddItemModal order={order} kind={dialog} onClose={close} />}
      {dialog === 'pay' && <RecordPaymentModal order={order} mode="record" onClose={close} />}
      {dialog === 'checkout' && <RecordPaymentModal order={order} mode="checkout" onClose={close} onDone={() => navigate(`/sales/orders/${order.id}/receipt`)} />}
      {dialog === 'correct' && <CorrectOrderModal order={order} onClose={close} />}
      {dialog === 'commit' && original && <CorrectOrderModal order={original} replacement={order} onClose={close} />}
      {dialog === 'request' && <PrepareRequestModal order={order} onClose={close} />}
      {dialog === 'finalize' && (
        <Modal open size="sm" modalHeading="Finalize order" modalLabel={order.reference} primaryButtonText="Finalize" secondaryButtonText="Cancel" preventCloseOnClickOutside onRequestClose={close}
          onRequestSubmit={() => { act(() => store.finalizeOrder(order.id), { title: `${order.reference} finalized`, subtitle: order.fulfillmentMode === 'deferred' ? 'Payments can be recorded now or when the customer picks it up.' : 'Payments can be recorded now.' }); close(); }}>
          <Stack gap={4}>
            <p>Prices and items freeze, and the jobs on this order are reserved for it. Total: <strong>{formatEur(order.total)}</strong> for {order.customerLabel}.</p>
            <p className="mj-secondary">Later changes need a correction, which reverses this order and creates a replacement.</p>
          </Stack>
        </Modal>
      )}
      <DestructiveActionDialog open={dialog === 'cancel'} title="Cancel this draft?" confirmLabel="Cancel draft" cancelLabel="Keep draft" onClose={close}
        onConfirm={() => { act(() => store.cancelDraftOrder(order.id), { title: 'Draft cancelled', subtitle: `${order.reference} was never charged; its jobs are free again.` }); close(); }}>
        <p>{order.reference} was never finalized, so nothing was charged. The draft is kept as cancelled and its jobs can go on another order.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams();
  const { query, views } = useSalesData();
  const order = views.find((item) => item.id === orderId);
  const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders', to: '/sales/orders' }];
  return (
    <RequirePermission permission="orders.read" title="Order" crumbs={crumbs}>
      {query.status === 'success' && order ? <OrderDetail order={order} views={views} /> : (
        <PageShell title={query.status === 'success' ? 'Order not found' : 'Order'} breadcrumbs={crumbs} width="wide">
          <QueryBoundary query={query} errorMessage="The order could not be loaded.">
            <EmptyState title="This order does not exist" description="It may have been removed, or the link is incorrect." action={<Button kind="tertiary" as={Link} to="/sales/orders">Back to orders</Button>} />
          </QueryBoundary>
        </PageShell>
      )}
    </RequirePermission>
  );
}

