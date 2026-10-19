import { useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, MenuButton, MenuItem, Modal, OverflowMenu, OverflowMenuItem, Stack, Tile } from '@carbon/react';
import { Currency, Document as DocumentIcon, Printer } from '@carbon/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../../app/DestructiveActionDialog';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { LinkifiedText, RichNotification, RefLink } from '../../components/RefLink';
import { lookups, useStore } from '../../store';
import { InvoiceSection } from '../components/InvoiceSection';
import { OrderItemsTable } from '../components/OrderItemsTable';
import { OrderTimeline } from '../components/OrderTimeline';
import { PaymentsSection } from '../components/PaymentsSection';
import { RequirePermission } from '../components/RequirePermission';
import { AddItemModal } from '../dialogs/AddItemModal';
import { AddJobsModal } from '../dialogs/AddJobsModal';
import { CorrectOrderModal } from '../dialogs/CorrectOrderModal';
import { EditOrderModal } from '../dialogs/EditOrderModal';
import { RecordPaymentModal } from '../dialogs/RecordPaymentModal';
import { RequestInvoiceModal } from '../dialogs/RequestInvoiceModal';
import { invoiceRequestBlocker } from '../engine';
import { formatDateTime, formatEur } from '../format';
import { customerKindLabel, requestStateLabel } from '../labels';
import { acceptedMethods, activeItems, activeReceipts, itemChanged, type OrderView } from '../logic';
import { accountRoles } from '../pricing';
import { OrderStatusTag } from '../status';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

type Dialog = 'edit' | 'jobs' | 'catalog' | 'custom' | 'finalize' | 'cancel' | 'pay' | 'checkout' | 'correct' | 'commit' | 'invoice' | null;

function OrderDetail({ order, views }: { order: OrderView; views: OrderView[] }) {
  const store = useStore();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const draft = order.status === 'draft';
  const items = activeItems(order);
  const can = store.can;
  const canWrite = can('orders.write');
  const request = order.activeRequest;
  const original = order.replaces ? views.find((candidate) => candidate.id === order.replaces!.id) ?? null : null;
  const changedItems = items.filter((item) => itemChanged(item, store.jobs));
  const receipts = activeReceipts(store.payments, store.allocations, order.id);
  const recorded = can('payments.record') && can('payments.read');
  const methods = acceptedMethods(order);
  const bankTransfer = methods.length === 1 && methods[0] === 'external';
  const invoiceBlocker = invoiceRequestBlocker(store, order);

  const act = (fn: () => unknown, success?: { title: string; subtitle?: string }) => {
    try { fn(); if (success) store.notify({ kind: 'success', ...success }); } catch (error) { store.notify({ kind: 'error', title: 'That did not work', subtitle: error instanceof Error ? error.message : undefined }); }
  };

  const draftBlockers = draft ? [
    items.length === 0 && 'Add at least one item.',
    changedItems.length > 0 && `${changedItems.map((item) => item.snapshot?.displayId).join(', ')} changed since ${changedItems.length === 1 ? 'it was' : 'they were'} added. Refresh ${changedItems.length === 1 ? 'it' : 'them'} first.`,
  ].filter((value): value is string => !!value) : [];

  // The primary action depends on where the order is in its life.
  let primary: { label: string; icon?: typeof Currency; disabled?: boolean; run: () => void } | null = null;
  const checkoutPrimary = draft && !order.replacesOrderId && can('orders.finalize') && recorded;
  if (draft && order.replacesOrderId) primary = canWrite && can('orders.finalize') && can('orders.reverse') && recorded ? { label: 'Commit replacement…', disabled: draftBlockers.length > 0, run: () => setDialog('commit') } : null;
  else if (checkoutPrimary) primary = { label: 'Finalize and take payment', icon: Currency, disabled: draftBlockers.length > 0, run: () => setDialog('checkout') };
  else if (draft) primary = can('orders.finalize') ? { label: 'Finalize', disabled: draftBlockers.length > 0, run: () => setDialog('finalize') } : null;
  else if (order.status === 'finalized' && order.outstanding > 0 && recorded && methods.length > 0) primary = { label: bankTransfer ? 'Record bank transfer' : 'Record payment', icon: Currency, run: () => setDialog('pay') };
  else if (order.status === 'finalized' && receipts.length > 0) primary = { label: 'Print receipt', icon: Printer, run: () => navigate(`/sales/orders/${order.id}/receipt`) };
  else if (order.status === 'reversed' && order.replacedBy) primary = { label: `Open ${order.replacedBy.reference}`, run: () => navigate(`/sales/orders/${order.replacedBy!.id}`) };
  else if (order.status === 'reversed' && canWrite && can('orders.finalize') && can('orders.reverse')) primary = { label: 'Replace with a corrected order', run: () => setDialog('correct') };
  else if ((order.status === 'cancelled') && canWrite) primary = { label: 'Duplicate as draft', run: () => act(() => navigate(`/sales/orders/${store.duplicateOrder(order.id).orderId}`)) };

  const canCorrect = (order.status === 'finalized' || order.status === 'reversed') && can('orders.finalize') && (can('orders.reverse') || order.status === 'reversed') && recorded && !order.replacedBy;
  const menu = [
    draft && canWrite && <OverflowMenuItem key="edit" itemText="Edit customer and hand-over" onClick={() => setDialog('edit')} />,
    draft && !order.replacesOrderId && checkoutPrimary && can('orders.finalize') && <OverflowMenuItem key="finalize" itemText="Finalize without payment" disabled={draftBlockers.length > 0} onClick={() => setDialog('finalize')} />,
    canCorrect && <OverflowMenuItem key="correct" itemText="Correct order…" onClick={() => setDialog('correct')} />,
    order.status === 'finalized' && order.net > 0 && receipts.length > 0 && primary?.label !== 'Print receipt' && <OverflowMenuItem key="receipt" itemText="Print receipt" onClick={() => navigate(`/sales/orders/${order.id}/receipt`)} />,
    !draft && canWrite && order.status !== 'cancelled' && primary?.label !== 'Duplicate as draft' && <OverflowMenuItem key="duplicate" itemText="Duplicate as draft" onClick={() => act(() => navigate(`/sales/orders/${store.duplicateOrder(order.id).orderId}`))} />,
    draft && canWrite && <OverflowMenuItem key="cancel" itemText="Cancel draft" isDelete hasDivider onClick={() => setDialog('cancel')} />,
  ].filter(Boolean);

  // Invoice action next to the primary one: request an invoice, or jump to the running request.
  const invoiceAction = order.status !== 'finalized' ? null
    : request ? { label: 'View invoice', run: () => document.getElementById('order-invoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
    : can('external_invoice_requests.manage') && invoiceBlocker === null ? { label: 'Request invoice', run: () => setDialog('invoice') } : null;
  const recordBlocked = request && methods.length === 0 ? `${request.reference} is ${requestStateLabel[request.state].toLowerCase()}: cash and card can no longer be added. A bank transfer is recorded once the invoice is issued.` : null;
  const customerRole = order.customer.kind === 'person' ? lookupRoles(order.customer.id) : null;

  return (
    <PageShell
      title={order.reference} titleAdornment={<OrderStatusTag order={order} />} width="wide"
      description={`${order.customerLabel} · created ${formatDateTime(order.createdAt)} by ${order.createdBy}`}
      breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders', to: '/sales/orders' }]}
      actions={<>
        {invoiceAction && <Button kind="secondary" renderIcon={DocumentIcon} onClick={invoiceAction.run}>{invoiceAction.label}</Button>}
        {primary && <Button kind="primary" renderIcon={primary.icon} disabled={primary.disabled} onClick={primary.run}>{primary.label}</Button>}
        {menu.length > 0 && <OverflowMenu aria-label="More order actions" iconDescription="More order actions" flipped>{menu}</OverflowMenu>}
      </>}
    >
      <div className="mj-stack">
        {order.replaces && draft && (
          <RichNotification kind="info" title="This draft replaces an order"><RefLink reference={order.replaces.reference} id={order.replaces.id} />. Change the items as needed, then commit the replacement. The original is reversed at that moment and its payments move over.
          </RichNotification>
        )}
        {order.replacedBy && <RichNotification kind="info" title="This order was replaced"><RefLink reference={order.replacedBy.reference} id={order.replacedBy.id} /> is charged now. This order no longer counts.</RichNotification>}
        {order.replaces && !draft && <RichNotification kind="info" title="This order replaces another one"><RefLink reference={order.replaces.reference} id={order.replaces.id} />. Payments that were already made moved over to this order.</RichNotification>}
        {draftBlockers.length > 0 && <RichNotification kind="warning" title="Before you can continue"><LinkifiedText text={draftBlockers.join(' ')} /></RichNotification>}
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
                  <MenuItem label="Jobs…" onClick={() => setDialog('jobs')} />
                  <MenuItem label="Catalog item… (proposed)" onClick={() => setDialog('catalog')} />
                  <MenuItem label="Custom item…" onClick={() => setDialog('custom')} />
                </MenuButton>
              </div>
            )}
            <OrderItemsTable
              order={order} jobs={store.jobs} editable={draft && canWrite} busy={false}
              onRefresh={(item) => act(() => store.refreshOrderItem(order.id, item.id), { title: 'Job refreshed', subtitle: 'The item now has the job’s current price.' })}
              onRemove={(item) => act(() => store.removeOrderItem(order.id, item.id), { title: 'Item removed' })}
              onSave={(item, input) => act(() => store.updateOrderManualItem(order.id, item.id, input), { title: 'Item updated' })}
            />
            <PaymentsSection order={order} orders={store.orders} payments={store.payments} allocations={store.allocations} canRecord={recorded && order.status === 'finalized' && order.outstanding > 0 && methods.length > 0}
              recordBlocked={recordBlocked} bankTransfer={bankTransfer} onRecord={() => setDialog('pay')} />
            {order.latestRequest && <div id="order-invoice"><InvoiceSection order={order} request={order.latestRequest} /></div>}
          </div>
          <div className="mj-stack">
            <Tile>
              <h2 className="mj-section-title">Details</h2>
              <dl className="mj-facts sales-facts">
                <div><dt>Customer</dt><dd><CarbonLink as={Link} to={`/sales/orders?customer=${order.customer.id}`}>{order.customerLabel}</CarbonLink><br /><span className="mj-secondary">{customerKindLabel(order.customer.kind)}{customerRole ? ` · ${customerRole}` : ''} · all their orders</span></dd></div>
                <div><dt>Hand-over</dt><dd>{order.fulfillmentMode === 'immediate' ? 'Handed over now' : 'Customer picks up later'}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(order.createdAt)}</dd></div>
                <div><dt>Last change</dt><dd>{formatDateTime(order.updatedAt)}</dd></div>
                {order.replaces && <div><dt>Replaces</dt><dd><RefLink reference={order.replaces.reference} id={order.replaces.id} /></dd></div>}
                {order.replacedBy && <div><dt>Replaced by</dt><dd><RefLink reference={order.replacedBy.reference} id={order.replacedBy.id} /></dd></div>}
                {order.latestRequest && <div><dt>Invoice request</dt><dd>{order.latestRequest.reference}</dd></div>}
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
      {dialog === 'checkout' && <RecordPaymentModal order={order} mode="checkout" onClose={close} onRequestInvoice={can('external_invoice_requests.manage') ? () => setDialog('invoice') : undefined} />}
      {dialog === 'correct' && <CorrectOrderModal order={order} onClose={close} />}
      {dialog === 'commit' && original && <CorrectOrderModal order={original} replacement={order} onClose={close} />}
      {dialog === 'invoice' && <RequestInvoiceModal order={order} onClose={close} />}
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

/** The highest-priority account role of a person, for the customer fact. */
function lookupRoles(personId: string): string | null {
  const party = lookups.people.find((item) => item.id === personId);
  const role = accountRoles.find((item) => party?.roles.includes(item.id));
  return role ? `role ${role.label}` : null;
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
