import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useStore } from '../../store';
import { checkEntry, existingReferences, newPaymentEntry, PaymentEntryForm, toPaymentInputs } from '../components/PaymentEntry';
import { formatEur } from '../format';
import { acceptedMethods, type OrderView } from '../logic';
import { OrderStatusTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { PaymentMethod } from '../types';

/**
 * Records one or several receipts (split payment) on a finalized order. In `checkout` mode the order is still a draft: it is finalized and
 * paid in one step ("Finalize and take payment"). A partial payment is fine; the rest stays outstanding.
 */
export function RecordPaymentModal({ order, mode, onClose, onDone }: { order: OrderView; mode: 'record' | 'checkout'; onClose: () => void; onDone?: () => void }) {
  const store = useStore();
  const checkout = mode === 'checkout';
  const due = checkout ? order.total : order.outstanding;
  const methods = checkout ? (['cash', 'card'] as PaymentMethod[]) : acceptedMethods(order);
  const external = methods.length === 1 && methods[0] === 'external';
  const [entry, setEntry] = useState(() => ({ ...newPaymentEntry(due, methods.length ? methods : ['cash', 'card']) }));
  const check = checkEntry(entry, due, external, existingReferences(store.payments));
  const { mutate, pending, error } = useSalesMutation(() => {
    const inputs = toPaymentInputs(entry);
    return checkout ? store.checkoutOrder(order.id, inputs) : store.recordOrderPayments(order.id, inputs);
  });

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: checkout ? `${order.reference} finalized` : external ? 'Bank transfer recorded' : 'Payment recorded', subtitle: `${formatEur(check.covered)} on ${order.reference}${check.remaining > 0 ? `, ${formatEur(check.remaining)} still outstanding` : ''}.`, action: { label: 'Print receipt', to: `/sales/orders/${order.id}/receipt` } });
    onDone?.();
    onClose();
  };

  return (
    <Modal
      open size="md" modalHeading={checkout ? 'Finalize and take payment' : external ? 'Record bank transfer' : 'Record payment'} modalLabel={order.reference}
      primaryButtonText={pending ? 'Saving…' : checkout ? 'Finalize and record payment' : external ? 'Record bank transfer' : 'Record payment'} secondaryButtonText="Cancel" primaryButtonDisabled={!check.ok || pending || methods.length === 0}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <div className="sales-modal-summary">
          <div><span className="mj-secondary">{checkout ? 'Total to pay' : 'Outstanding'}</span><strong className="sales-modal-summary__amount">{formatEur(due)}</strong></div>
          <div className="mj-cell-stack"><span>{order.customerLabel}</span><OrderStatusTag order={order} size="sm" /></div>
        </div>
        {checkout && <p>Prices and items freeze when you finalize. The payment is recorded in the same step.</p>}
        {!external && <p className="mj-secondary">Partial payments are fine; the rest stays outstanding.</p>}
        {external && <p>The invoice {order.activeRequest?.reference} was issued by wiRef. Record the bank transfer to the HTU account once it arrived, with the confirmation reference. Cash and card were recorded before the invoice.</p>}
        {methods.length === 0 && <InlineNotification kind="warning" lowContrast hideCloseButton title="No payment can be recorded right now" subtitle={`${order.activeRequest?.reference} is not issued yet. Cash and card can no longer be added, and a bank transfer is recorded after the invoice is issued.`} />}
        {methods.length > 0 && <PaymentEntryForm idPrefix={`pay-${order.id}`} entry={entry} onChange={setEntry} due={due} requireFull={external} payments={store.payments} methods={methods} disabled={pending} />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not record" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
