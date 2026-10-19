import { useState } from 'react';
import {
  Accordion, AccordionItem, Button, ContainedList, ContainedListItem, InlineNotification, OverflowMenu, OverflowMenuItem, ProgressIndicator, ProgressStep, Tile,
} from '@carbon/react';
import { CheckmarkFilled, Currency, Misuse, Receipt } from '@carbon/icons-react';
import { formatDate, formatDateTime, formatEur } from '../format';
import { reconciliationLabels, requestEventLabel, requestStateLabel } from '../labels';
import { INVOICE_STEPS, requestNext, requestProgress, requestReadiness, type OrderView } from '../logic';
import { RequestDialog, type RequestDialogKind } from '../dialogs/RequestDialogs';
import { RequestInvoiceModal } from '../dialogs/RequestInvoiceModal';
import { RecordPaymentModal } from '../dialogs/RecordPaymentModal';
import { invoiceRequestBlocker } from '../engine';
import { RequestStateTag } from '../status';
import { useMediaQuery } from '../useMediaQuery';
import { LinkifiedText } from '../../components/RefLink';
import { useStore } from '../../store';
import type { InvoiceRequest, InvoiceRequestDetails } from '../types';
import { RecipientDetailsForm } from './RecipientDetailsForm';

function Frozen({ details }: { details: InvoiceRequestDetails }) {
  return (
    <dl className="mj-facts sales-facts">
      <div><dt>Recipient</dt><dd>{details.recipientName || '—'}</dd></div>
      <div><dt>Address</dt><dd>{[details.addressLine1, `${details.postalCode} ${details.locality}`.trim(), details.countryCode].filter(Boolean).join(', ') || '—'}</dd></div>
      {details.contactName && <div><dt>Contact person</dt><dd>{details.contactName}</dd></div>}
      {details.purchaseOrderReference && <div><dt>Purchase order</dt><dd>{details.purchaseOrderReference}</dd></div>}
      <div><dt>Service period</dt><dd>{details.serviceStartsOn ? `${formatDate(`${details.serviceStartsOn}T12:00:00Z`)} to ${details.serviceEndsOn ? formatDate(`${details.serviceEndsOn}T12:00:00Z`) : '—'}` : '—'}</dd></div>
      <div><dt>Description</dt><dd>{details.serviceDescription || '—'}</dd></div>
    </dl>
  );
}

/** The invoice of an order, issued by wiRef: progress, the next step with every action of the state, recipient details, checklist and history. */
export function InvoiceSection({ order, request }: { order: OrderView; request: InvoiceRequest }) {
  const store = useStore();
  const narrow = useMediaQuery('(max-width: 41.98rem)');
  const [dialog, setDialog] = useState<RequestDialogKind | 'pay' | 'again' | null>(null);
  const [live, setLive] = useState<{ details: InvoiceRequestDetails; dirty: boolean }>({ details: request.details, dirty: false });
  const organization = store.organizations.find((item) => item.id === order.customer.id);
  const canManage = store.can('external_invoice_requests.manage');
  const draft = request.state === 'draft';
  const checklist = requestReadiness({ details: draft ? live.details : request.details }, order.customer, organization);
  const complete = checklist.every((item) => item.ok);
  const paid = order.settlement === 'paid' || order.settlement === 'no_payment_due';
  const progress = requestProgress(request);
  const predecessor = store.requests.find((item) => item.id === request.supersedesRequestId);
  const issuedEvent = [...request.events].reverse().find((event) => event.kind === 'reference_corrected' || event.kind === 'issued');
  const newBlocker = invoiceRequestBlocker(store, order);
  const canRecordTransfer = request.state === 'issued' && order.outstanding > 0 && store.can('payments.record') && store.can('payments.read');

  let primary: { label: string; disabled?: boolean; run: () => void } | null = null;
  if (canManage) {
    if (draft) primary = { label: 'Mark as ready', disabled: !complete || live.dirty, run: () => setDialog('ready') };
    else if (request.state === 'ready') primary = { label: 'Mark as submitted', run: () => setDialog('submitted') };
    else if (request.state === 'submitted') primary = { label: 'Record issued invoice', run: () => setDialog('issued') };
    else if (request.state === 'cancellation_requested') primary = { label: 'Confirm cancellation', run: () => setDialog('confirm-cancellation') };
    else if (request.state === 'cancelled' && newBlocker === null) primary = { label: 'Request invoice again', run: () => setDialog('again') };
  }
  if (canRecordTransfer) primary = { label: 'Record bank transfer', run: () => setDialog('pay') };
  const menu = canManage ? [
    (request.state === 'draft' || request.state === 'ready') && <OverflowMenuItem key="cancel" itemText="Cancel request" isDelete onClick={() => setDialog('cancel')} />,
    (request.state === 'submitted' || request.state === 'issued') && <OverflowMenuItem key="request-cancellation" itemText="Request cancellation…" onClick={() => setDialog('request-cancellation')} />,
    (request.state === 'issued' || request.state === 'cancellation_requested') && <OverflowMenuItem key="reference" itemText="Correct invoice reference…" onClick={() => setDialog('correct-reference')} />,
  ].filter(Boolean) : [];
  const history = [...request.events].sort((a, b) => b.at.localeCompare(a.at));
  const toPay = request.state === 'cancelled' ? null : order.outstanding;

  return (
    <Tile id="invoice" className="sales-invoice">
      <div className="sales-invoice__head">
        <h2 className="mj-section-title mj-inline">Invoice <RequestStateTag request={request} size="md" /></h2>
        <span className="mj-inline">
          {primary && <Button kind="primary" size="md" renderIcon={primary.label === 'Record bank transfer' ? Currency : undefined} disabled={primary.disabled} onClick={primary.run}>{primary.label}</Button>}
          {menu.length > 0 && <OverflowMenu aria-label="More invoice actions" iconDescription="More invoice actions" flipped>{menu}</OverflowMenu>}
        </span>
      </div>
      <ProgressIndicator currentIndex={progress.index} spaceEqually vertical={narrow} className="sales-progress">
        {INVOICE_STEPS.map((label, index) => (
          <ProgressStep key={label} label={label} invalid={progress.invalid && index === progress.index} secondaryLabel={progress.invalid && index === progress.index ? requestStateLabel[request.state] : undefined} />
        ))}
      </ProgressIndicator>
      <p className="mj-secondary sales-top-gap">{request.reference} · Next step: {requestNext(request, paid, complete)}</p>

      <dl className="mj-facts sales-facts sales-top-gap">
        <div><dt>Invoice amount</dt><dd>{formatEur(request.requestedAmount)}{order.net !== request.requestedAmount && ` (the order is now ${formatEur(order.net)})`}</dd></div>
        <div><dt>Already paid (cash or card)</dt><dd>{formatEur(request.alreadyPaid)}{request.state === 'draft' && request.alreadyPaid > 0 ? ' · follows payments until it is ready' : ''}</dd></div>
        {toPay !== null && <div><dt>{paid ? 'Payment' : 'Still to pay by bank transfer'}</dt><dd>{paid ? 'Paid in full, the invoice is marked paid' : formatEur(toPay)}</dd></div>}
        {issuedEvent?.externalReference && <div><dt>Invoice number</dt><dd>{issuedEvent.externalReference}{issuedEvent.effectiveOn && <span className="mj-secondary"> · {formatDate(`${issuedEvent.effectiveOn}T12:00:00Z`)}</span>}</dd></div>}
        {predecessor && <div><dt>Replaces</dt><dd>{predecessor.reference}</dd></div>}
      </dl>

      <div className="mj-stack sales-top-gap">
        {request.state === 'cancellation_requested' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Waiting for the cancellation in wiRef" subtitle="Cash and card stay switched off for the order. Once wiRef cancelled or corrected the invoice, confirm it with the reference." />}
        {request.state === 'cancelled' && <InlineNotification kind="info" lowContrast hideCloseButton title="This request is cancelled" subtitle={newBlocker === null ? 'The order is free again. Request the invoice again, or take a cash or card payment.' : `The order cannot get a new request right now: ${newBlocker.toLowerCase()}.`} />}
        {request.state === 'issued' && !paid && <InlineNotification kind="info" lowContrast hideCloseButton title="Invoice issued, waiting for the bank transfer" subtitle={`${formatEur(order.outstanding)} is outstanding. Record the transfer to the HTU account once it arrived.`} />}
        {request.state === 'issued' && paid && <InlineNotification kind="success" lowContrast hideCloseButton title="Invoice paid" subtitle={`${order.reference} is paid in full.`} />}
        {!canManage && <InlineNotification kind="info" lowContrast hideCloseButton title="Read-only" subtitle="Changing an invoice request needs the permission to manage wiRef requests." />}
        {(draft || request.state === 'ready') && (
          <div>
            <p className="cds--label">Ready to submit?</p>
            <ul className="sales-checklist">
              {checklist.map((item) => (
                <li key={item.key}>
                  {item.ok ? <CheckmarkFilled className="sales-checklist__ok" /> : <Misuse className="sales-checklist__bad" />}
                  <span className="mj-cell-stack"><span>{item.label}</span>{!item.ok && <span className="mj-secondary">{item.hint}{item.key === 'po' && ' · set under Pricing > Organizations'}</span>}</span>
                </li>
              ))}
            </ul>
            {draft && live.dirty && <p className="mj-secondary sales-top-gap">Save the details to continue.</p>}
          </div>
        )}
        <Accordion size="md">
          <AccordionItem title="Recipient and service" open={draft}>
            {draft && canManage
              ? <RecipientDetailsForm request={request} organization={order.customer.kind === 'organization'} requiresPurchaseOrder={!!organization?.requiresPurchaseOrder} onChange={(details, dirty) => setLive({ details, dirty })} />
              : (
                <>
                  <Frozen details={request.details} />
                  {request.state !== 'draft' && request.state !== 'cancelled' && <p className="mj-secondary sales-top-gap">These details are frozen. To change them, cancel the request and request the invoice again.</p>}
                </>
              )}
          </AccordionItem>
          <AccordionItem title={`History (${history.length})`}>
            <ContainedList label="History" kind="disclosed" className="sales-timeline">
              {history.map((event) => (
                <ContainedListItem key={event.id} renderIcon={Receipt}>
                  <span className="mj-cell-stack">
                    <strong>{requestEventLabel[event.kind]}</strong>
                    <span><LinkifiedText text={event.text} /></span>
                    {(event.reconciliationKind || event.externalReference || event.effectiveOn) && (
                      <span className="mj-secondary">
                        {[event.reconciliationKind && reconciliationLabels[event.reconciliationKind].label, event.externalReference && `Reference ${event.externalReference}`, event.effectiveOn && `effective ${formatDate(`${event.effectiveOn}T12:00:00Z`)}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span className="mj-secondary">{event.actor} · {formatDateTime(event.at)}</span>
                  </span>
                </ContainedListItem>
              ))}
            </ContainedList>
          </AccordionItem>
        </Accordion>
      </div>
      {dialog === 'pay' && <RecordPaymentModal order={order} mode="record" onClose={() => setDialog(null)} />}
      {dialog === 'again' && <RequestInvoiceModal order={order} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'pay' && dialog !== 'again' && <RequestDialog kind={dialog} request={request} order={order} onClose={() => setDialog(null)} />}
    </Tile>
  );
}
