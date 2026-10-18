import { InlineNotification, Modal, Stack } from '@carbon/react';
import { CheckmarkFilled, Misuse } from '@carbon/icons-react';
import { useStore } from '../../store';
import { formatEur } from '../format';
import { activeReceipts, type OrderView } from '../logic';
import { useSalesMutation } from '../useSalesMutation';

/** Starts a wiRef request for an organization or person that is invoiced instead of paying at the desk. The request itself is completed under Invoicing. */
export function PrepareRequestModal({ order, onClose }: { order: OrderView; onClose: () => void }) {
  const store = useStore();
  const checks = [
    { ok: order.status === 'finalized', label: 'The order is finalized' },
    { ok: !!order.customer, label: 'The order has a named customer' },
    { ok: activeReceipts(store.payments, store.allocations, order.id).length === 0, label: 'No cash or card payment was recorded yet' },
    { ok: !order.activeRequest, label: 'There is no other active wiRef request' },
  ];
  const ready = checks.every((check) => check.ok);
  const { mutate, pending, error } = useSalesMutation(() => store.prepareInvoiceRequest(order.id));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: 'wiRef request prepared', subtitle: `${order.reference} · ${formatEur(order.net)}. Complete the recipient details next.`, action: { label: 'Open Invoicing', to: `/sales/invoicing/${result.value.requestId}` } });
    onClose();
  };
  return (
    <Modal
      open size="sm" modalHeading="Prepare wiRef request" modalLabel={order.reference} primaryButtonText={pending ? 'Preparing…' : 'Prepare request'} secondaryButtonText="Cancel" primaryButtonDisabled={!ready || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <p>For customers who get an invoice instead of paying at the desk. Makerspace Core prepares the request and tracks it; the invoice itself is issued by wiRef. Cash and card are switched off for this order while the request is active.</p>
        <ul className="sales-checklist">
          {checks.map((check) => <li key={check.label}>{check.ok ? <CheckmarkFilled className="sales-checklist__ok" /> : <Misuse className="sales-checklist__bad" />}<span>{check.label}</span></li>)}
        </ul>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not prepare" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
