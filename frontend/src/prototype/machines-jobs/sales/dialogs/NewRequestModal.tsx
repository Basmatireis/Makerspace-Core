import { useState } from 'react';
import { Accordion, AccordionItem, ComboBox, InlineNotification, Modal, Stack } from '@carbon/react';
import { useStore } from '../../store';
import { invoiceRequestBlocker } from '../engine';
import { formatDate, formatEur } from '../format';
import type { OrderView } from '../logic';
import { useSalesMutation } from '../useSalesMutation';

/** Starts a wiRef request from the Invoicing list: pick a finalized order of a named customer that has no payment and no active request. */
export function NewRequestModal({ views, onClose, onCreated }: { views: OrderView[]; onClose: () => void; onCreated: (requestId: string) => void }) {
  const store = useStore();
  const candidates = views.filter((order) => order.status === 'finalized' && order.customer).map((order) => ({ order, blocker: invoiceRequestBlocker(store, order) }));
  const eligible = candidates.filter((item) => item.blocker === null).map((item) => item.order).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unavailable = candidates.filter((item) => item.blocker !== null).sort((a, b) => b.order.updatedAt.localeCompare(a.order.updatedAt)).slice(0, 12);
  const [selected, setSelected] = useState<OrderView | null>(null);
  const { mutate, pending, error } = useSalesMutation(() => store.prepareInvoiceRequest(selected!.id));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: 'wiRef request prepared', subtitle: `${selected!.reference} · ${formatEur(selected!.net)}. Complete the recipient details next.` });
    onCreated(result.value.requestId);
    onClose();
  };
  return (
    <Modal open size="md" modalHeading="New wiRef request" modalLabel="Invoicing" primaryButtonText={pending ? 'Preparing…' : 'Prepare request'} secondaryButtonText="Cancel" primaryButtonDisabled={!selected || pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <p>For customers who get an invoice instead of paying at the desk. Choose the finalized order that should be invoiced.</p>
        <ComboBox autoAlign id="new-request-order" titleText="Order" placeholder={eligible.length ? 'Search by order or customer' : 'No order is eligible'} items={eligible} selectedItem={selected}
          itemToString={(item) => item ? `${item.reference} · ${item.customerLabel} · ${formatEur(item.net)}` : ''} disabled={eligible.length === 0}
          shouldFilterItem={({ item, inputValue }) => !inputValue || !item || `${item.reference} ${item.customerLabel}`.toLowerCase().includes(inputValue.toLowerCase())} onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
          helperText={`${eligible.length} ${eligible.length === 1 ? 'order is' : 'orders are'} ready for a request.`} />
        {eligible.length === 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="No order is eligible right now" subtitle="An order needs to be finalized, belong to a named customer, have no cash or card payment and no active request." />}
        {selected && (
          <InlineNotification kind="info" lowContrast hideCloseButton title={`${selected.reference} for ${selected.customerLabel}`}
            subtitle={`${formatEur(selected.net)} will be requested. Created ${formatDate(selected.createdAt)}. Cash and card are switched off for this order while the request is active.`} />
        )}
        {unavailable.length > 0 && (
          <Accordion>
            <AccordionItem title={`Why are some orders missing? (${unavailable.length})`}>
              <ul className="sales-reason-list">
                {unavailable.map(({ order, blocker }) => <li key={order.id}><span>{order.reference} · {order.customerLabel}</span><span className="mj-secondary">{blocker}</span></li>)}
              </ul>
            </AccordionItem>
          </Accordion>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not prepare" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
