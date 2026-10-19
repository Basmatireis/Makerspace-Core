import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { checkoutOrder } from '../../api/generated/orders/orders';
import { recordOrderPayment } from '../../api/generated/payments/payments';
import type { Order } from '../../api/generated/models';
import { useNotify } from '../machinelogbook/shared/toasts';
import { acceptsCashAndCard, customerLabel } from './logic';
import { requestStateLabel } from './labels';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { checkEntry, newPaymentEntry, PaymentEntryForm, toPaymentInputs } from './PaymentEntry';
import { useFinanceMutation } from './queries';
import { OrderStatusTag } from './status';

/**
 * Records one or several receipts (split payment) on a finalized order. In `checkout` mode the order is still a draft: it is finalized and
 * paid in one step. A partial payment is fine; the rest stays outstanding. "Invoice" records nothing and hands over to the invoice request.
 */
export function RecordPaymentModal({ order, mode, onClose, onRequestInvoice }: {
  order: Order; mode: 'record' | 'checkout'; onClose: () => void;
  /** When set, the modal offers "Invoice"; at checkout the order is finalized first. Then the invoice request opens. */
  onRequestInvoice?: () => void;
}) {
  const notify = useNotify();
  const key = useOperationKeys();
  const checkout = mode === 'checkout';
  const due = checkout ? toCents(order.totalAmount) : toCents(order.outstandingAmount);
  const open = checkout || acceptsCashAndCard(order);
  const [entry, setEntry] = useState(() => newPaymentEntry(due));
  const invoice = entry.preset === 'invoice';
  const check = checkEntry(entry, due, false);

  const mutation = useFinanceMutation(async () => {
    if (invoice) {
      if (checkout) {
        const input = { expectedVersion: order.version, payments: [] };
        await checkoutOrder(order.id, { ...input, operationKey: key('checkout-invoice', input) });
      }
      return;
    }
    const payments = toPaymentInputs(entry);
    if (checkout) {
      const input = { expectedVersion: order.version, payments };
      await checkoutOrder(order.id, { ...input, operationKey: key('checkout', input) });
      return;
    }
    // Every receipt bumps the order version, so the next one is sent with the version the previous one returned.
    let version = order.version;
    for (const payment of payments) {
      const input = { expectedVersion: version, payment };
      version = (await recordOrderPayment(order.id, { ...input, operationKey: key('payment', input) })).version;
    }
  }, () => {
    if (invoice) {
      notify({ kind: 'success', title: checkout ? `${order.reference} finalized` : 'Invoice', subtitle: 'Check the recipient details to request the invoice from wiRef.' });
      onClose();
      onRequestInvoice?.();
      return;
    }
    notify({ kind: 'success', title: checkout ? `${order.reference} finalized` : 'Payment recorded', subtitle: `${formatCents(check.covered)} on ${order.reference}${check.remaining > 0 ? `, ${formatCents(check.remaining)} still outstanding` : ''}.` });
    onClose();
  });

  const submit = () => {
    // On a finalized order "Invoice" records nothing; it only hands over to the invoice request.
    if (invoice && !checkout) { onClose(); onRequestInvoice?.(); return; }
    mutation.mutate();
  };
  const pending = mutation.isPending;
  const state = order.activeExternalRequestState;

  return (
    <Modal
      open size="md" modalHeading={checkout ? 'Finalize and take payment' : 'Record payment'} modalLabel={order.reference}
      primaryButtonText={pending ? 'Saving…' : invoice ? (checkout ? 'Finalize and request invoice' : 'Request invoice') : checkout ? 'Finalize and record payment' : 'Record payment'} secondaryButtonText="Cancel"
      primaryButtonDisabled={(!invoice && !check.ok) || pending || !open}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={submit}
    >
      <Stack gap={5}>
        <div className="sales-modal-summary">
          <div><span className="mj-secondary">{checkout ? 'Total to pay' : 'Outstanding'}</span><strong className="sales-modal-summary__amount">{formatCents(due)}</strong></div>
          <div className="mj-cell-stack"><span>{customerLabel(order)}</span><OrderStatusTag order={order} size="sm" /></div>
        </div>
        {checkout && <p>Prices and items freeze when you finalize. {invoice ? 'The invoice request follows right after.' : 'The payment is recorded in the same step.'}</p>}
        {!invoice && <p className="mj-secondary">Partial payments are fine; the rest stays outstanding.</p>}
        {!open && <InlineNotification kind="warning" lowContrast hideCloseButton title="No payment can be recorded right now" subtitle={`${order.activeExternalRequestReference} is ${state ? (requestStateLabel[state as keyof typeof requestStateLabel] ?? state).toLowerCase() : 'active'}, so cash and card can no longer be added. An issued invoice settles the balance by itself.`} />}
        {open && <PaymentEntryForm idPrefix={`pay-${order.id}`} entry={entry} onChange={setEntry} due={due} requireFull={false} disabled={pending} allowInvoice={!!onRequestInvoice && due > 0} />}
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not record" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}
