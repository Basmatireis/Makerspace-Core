import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useStore } from '../../store';
import { checkEntry, existingReferences, newPaymentEntry, PaymentEntryForm, toPaymentInputs } from '../components/PaymentEntry';
import { formatEur } from '../format';
import type { OrderView } from '../logic';
import { OrderStatusTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { PaymentMethod } from '../types';

/**
 * Records one or several receipts (split payment) on a finalized order. In `checkout` mode the order is still a draft:
 * a walk-in order is finalized and paid in one step and has to be covered completely.
 */
export function RecordPaymentModal({ order, mode, onClose, onDone }: { order: OrderView; mode: 'record' | 'checkout'; onClose: () => void; onDone?: () => void }) {
  const store = useStore();
  const checkout = mode === 'checkout';
  const walkIn = !order.customer;
  const due = checkout ? order.total : order.outstanding;
  const external = !checkout && order.activeRequest?.state === 'issued';
  const methods: PaymentMethod[] = external ? ['external'] : ['cash', 'card'];
  const [entry, setEntry] = useState(() => ({ ...newPaymentEntry(due, methods) }));
  const requireFull = walkIn || external;
  const check = checkEntry(entry, due, requireFull, existingReferences(store.payments));
  const { mutate, pending, error } = useSalesMutation(() => {
    const inputs = toPaymentInputs(entry);
    return checkout ? store.checkoutOrder(order.id, inputs) : store.recordOrderPayments(order.id, inputs);
  });

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: checkout ? `${order.reference} finalized and paid` : 'Payment recorded', subtitle: `${formatEur(check.covered)} on ${order.reference}.` });
    onDone?.();
    onClose();
  };

  return (
    <Modal
      open size="md" modalHeading={checkout ? 'Check out' : external ? 'Record payment from wiRef' : 'Record payment'} modalLabel={order.reference}
      primaryButtonText={pending ? 'Saving…' : checkout ? 'Finalize and pay' : 'Record payment'} secondaryButtonText="Cancel" primaryButtonDisabled={!check.ok || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <div className="sales-modal-summary">
          <div><span className="mj-secondary">{checkout ? 'Total to pay' : 'Outstanding'}</span><strong className="sales-modal-summary__amount">{formatEur(due)}</strong></div>
          <div className="mj-cell-stack"><span>{order.customerLabel}</span><OrderStatusTag order={order} size="sm" /></div>
        </div>
        {walkIn && <InlineNotification kind="info" lowContrast hideCloseButton title="Walk-in sale" subtitle="It has to be paid in full right now. Split it between cash and card if needed." />}
        {!walkIn && !external && <p className="mj-secondary">Partial payments are fine; the rest stays outstanding. Cash and card cannot be combined with a wiRef payment.</p>}
        {external && <p>The invoice was issued by wiRef. Record the payment once the accounting department confirmed it, with the confirmation reference.</p>}
        <PaymentEntryForm idPrefix={`pay-${order.id}`} entry={entry} onChange={setEntry} due={due} requireFull={requireFull} payments={store.payments} methods={methods} disabled={pending} />
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not record" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
