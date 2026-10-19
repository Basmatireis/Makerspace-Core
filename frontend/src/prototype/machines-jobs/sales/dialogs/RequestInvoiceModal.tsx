import { useMemo, useState } from 'react';
import { InlineNotification, Modal, Stack, Tile } from '@carbon/react';
import { CheckmarkFilled, Misuse } from '@carbon/icons-react';
import { lookups, useStore } from '../../store';
import { RecipientFields } from '../components/RecipientDetailsForm';
import { defaultRequestDetails } from '../engine';
import { formatEur } from '../format';
import { paidByCashOrCard, requestReadiness, type OrderView } from '../logic';
import { accountBilling } from '../mockData';
import { ProposedTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { InvoiceRequestDetails } from '../types';

/**
 * Asks wiRef for an invoice of the order. The recipient is prefilled from the customer (organization or account). [proposed] This works whether or not the
 * customer already paid: cash and card already received are carried on the request, the rest is settled by the invoice once management forwards it to wiRef.
 */
export function RequestInvoiceModal({ order, onClose }: { order: OrderView; onClose: () => void }) {
  const store = useStore();
  const organization = store.organizations.find((item) => item.id === order.customer.id);
  const isOrganization = order.customer.kind === 'organization';
  const initial = useMemo<InvoiceRequestDetails>(() => {
    const billing = organization?.billing ?? accountBilling[order.customer.id];
    return { ...defaultRequestDetails(order, new Date().toISOString()), recipientName: lookups.people.find((party) => party.id === order.customer.id)?.displayName ?? order.customerLabel, ...(billing ?? {}) };
  }, [order, organization]);
  const [details, setDetails] = useState(initial);
  const checklist = requestReadiness({ details }, order.customer, organization);
  const open = checklist.filter((item) => !item.ok);
  const alreadyPaid = paidByCashOrCard(store.payments, store.allocations, order.id);
  const { mutate, pending, error } = useSalesMutation(() => store.prepareInvoiceRequest(order.id, details));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: 'Invoice requested', subtitle: `${order.reference} · ${formatEur(order.net)}${alreadyPaid > 0 ? `, ${formatEur(alreadyPaid)} already paid` : ''}. Complete the details, then submit it for approval.` });
    onClose();
  };
  return (
    <Modal open size="md" modalHeading="Request invoice" modalLabel={order.reference} primaryButtonText={pending ? 'Requesting…' : 'Request invoice'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <p>Core hands the data over once management approved it; the invoice itself is issued by wiRef. Check the recipient, then request it.</p>
        <Tile>
          <h3 className="mj-section-title"><span className="mj-inline">Payment <ProposedTag hint="Today the backend refuses an invoice request once a cash or card payment exists" /></span></h3>
          <dl className="mj-facts sales-facts">
            <div><dt>Invoice amount</dt><dd>{formatEur(order.net)}</dd></div>
            <div><dt>Already paid (cash or card)</dt><dd>{formatEur(alreadyPaid)}</dd></div>
            <div><dt>Still open</dt><dd>{formatEur(order.outstanding)}</dd></div>
          </dl>
          <p className="mj-secondary sales-top-gap">
            {alreadyPaid > 0 ? 'What was paid is stated on the invoice request and the invoice is marked paid for it. ' : ''}
            {order.outstanding > 0 ? 'The order stays open until management forwards the invoice to wiRef; then the invoice settles the rest and the order is paid.' : 'The order is paid in full, so the invoice is marked paid.'}
          </p>
        </Tile>
        <RecipientFields idPrefix="request-invoice" details={details} onChange={(patch) => setDetails((current) => ({ ...current, ...patch }))} organization={isOrganization} requiresPurchaseOrder={!!organization?.requiresPurchaseOrder} disabled={pending} />
        <div>
          <p className="cds--label">Ready to submit?</p>
          <ul className="sales-checklist">
            {checklist.map((item) => (
              <li key={item.key}>
                {item.ok ? <CheckmarkFilled className="sales-checklist__ok" /> : <Misuse className="sales-checklist__bad" />}
                <span className="mj-cell-stack"><span>{item.label}</span>{!item.ok && <span className="mj-secondary">{item.hint}</span>}</span>
              </li>
            ))}
          </ul>
          {open.length > 0 && <p className="mj-secondary sales-top-gap">You can request the invoice now and complete {open.length === 1 ? 'this' : 'these'} later; it cannot be submitted for approval before.</p>}
        </div>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not request the invoice" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
